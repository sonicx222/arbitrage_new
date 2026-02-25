/**
 * Unit Tests for Swap Decoders
 *
 * Tests for individual DEX decoders (Uniswap V2/V3, Curve) and decoder registry.
 * Following TDD approach - tests written first, implementation to follow.
 *
 * @see Task 1.3.2: Pending Transaction Decoder (Implementation Plan v3.0)
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RecordingLogger } from '@arbitrage/core/logging';
import type { Logger } from '@arbitrage/core';
import type { RawPendingTransaction, PendingSwapIntent, SwapRouterType, SwapDecoder } from '../../src/types';

// Import will be created in implementation
import {
  UniswapV2Decoder,
  UniswapV3Decoder,
  CurveDecoder,
  DecoderRegistry,
  createDecoderRegistry,
  SWAP_FUNCTION_SELECTORS,
} from '../../src/decoders';

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * WETH address on Ethereum mainnet.
 */
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/**
 * USDC address on Ethereum mainnet.
 */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

/**
 * DAI address on Ethereum mainnet.
 */
const DAI = '0x6B175474E89094C44Da98b954EeadCDeBc5C5e818';

/**
 * USDT address on Ethereum mainnet.
 */
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/**
 * Uniswap V2 Router address on Ethereum mainnet.
 */
const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

/**
 * Uniswap V3 SwapRouter address on Ethereum mainnet.
 */
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

/**
 * Uniswap V3 SwapRouter02 address on Ethereum mainnet.
 */
const UNISWAP_V3_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

/**
 * Curve 3pool address on Ethereum mainnet.
 */
const CURVE_3POOL = '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7';

/**
 * Curve StableSwap Router (Router-NG) on Ethereum mainnet.
 */
const CURVE_ROUTER = '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D';

/**
 * Create a mock raw pending transaction.
 */
function createMockTx(overrides: Partial<RawPendingTransaction> = {}): RawPendingTransaction {
  return {
    hash: '0x' + 'a'.repeat(64),
    from: '0x' + '1'.repeat(40),
    to: UNISWAP_V2_ROUTER,
    value: '0x0',
    input: '0x',
    gas: '0x30d40', // 200000
    gasPrice: '0x12a05f200', // 5 gwei
    nonce: '0x1',
    chainId: 1,
    ...overrides,
  };
}

// =============================================================================
// REAL CALLDATA FIXTURES
// =============================================================================

/**
 * Real encoded calldata for swapExactTokensForTokens.
 * swapExactTokensForTokens(1000000000000000000, 900000000, [WETH, USDC], 0x123..., deadline)
 */
const SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA =
  '0x38ed1739' + // selector
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amountIn: 1 ETH
  '0000000000000000000000000000000000000000000000000000000035a4e900' + // amountOutMin: ~900 USDC
  '00000000000000000000000000000000000000000000000000000000000000a0' + // path offset
  '0000000000000000000000001234567890123456789012345678901234567890' + // to
  '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
  '0000000000000000000000000000000000000000000000000000000000000002' + // path length
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC

/**
 * Real encoded calldata for swapExactETHForTokens.
 * swapExactETHForTokens(900000000, [WETH, USDC], 0x123..., deadline)
 */
const SWAP_EXACT_ETH_FOR_TOKENS_CALLDATA =
  '0x7ff36ab5' + // selector
  '0000000000000000000000000000000000000000000000000000000035a4e900' + // amountOutMin: ~900 USDC
  '0000000000000000000000000000000000000000000000000000000000000080' + // path offset
  '0000000000000000000000001234567890123456789012345678901234567890' + // to
  '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
  '0000000000000000000000000000000000000000000000000000000000000002' + // path length
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC

/**
 * Real encoded calldata for swapExactTokensForETH.
 * swapExactTokensForETH(1000000000, 900000000000000000, [USDC, WETH], 0x123..., deadline)
 */
const SWAP_EXACT_TOKENS_FOR_ETH_CALLDATA =
  '0x18cbafe5' + // selector
  '000000000000000000000000000000000000000000000000000000003b9aca00' + // amountIn: 1000 USDC
  '0000000000000000000000000000000000000000000000000c7d713b49da0000' + // amountOutMin: ~0.9 ETH
  '00000000000000000000000000000000000000000000000000000000000000a0' + // path offset
  '0000000000000000000000001234567890123456789012345678901234567890' + // to
  '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
  '0000000000000000000000000000000000000000000000000000000000000002' + // path length
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // USDC
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; // WETH

/**
 * Real encoded calldata for swapTokensForExactTokens.
 * swapTokensForExactTokens(1000000000, 1100000000000000000, [WETH, USDC], 0x123..., deadline)
 */
const SWAP_TOKENS_FOR_EXACT_TOKENS_CALLDATA =
  '0x8803dbee' + // selector
  '000000000000000000000000000000000000000000000000000000003b9aca00' + // amountOut: 1000 USDC
  '0000000000000000000000000000000000000000000000000f43fc2c04ee0000' + // amountInMax: ~1.1 ETH
  '00000000000000000000000000000000000000000000000000000000000000a0' + // path offset
  '0000000000000000000000001234567890123456789012345678901234567890' + // to
  '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
  '0000000000000000000000000000000000000000000000000000000000000002' + // path length
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC

/**
 * Real encoded calldata for Uniswap V3 exactInputSingle.
 * exactInputSingle((tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMin, sqrtPriceLimitX96))
 */
const V3_EXACT_INPUT_SINGLE_CALLDATA =
  '0x414bf389' + // selector
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // tokenIn: WETH
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // tokenOut: USDC
  '0000000000000000000000000000000000000000000000000000000000000bb8' + // fee: 3000 (0.3%)
  '0000000000000000000000001234567890123456789012345678901234567890' + // recipient
  '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amountIn: 1 ETH
  '0000000000000000000000000000000000000000000000000000000035a4e900' + // amountOutMinimum: ~900 USDC
  '0000000000000000000000000000000000000000000000000000000000000000'; // sqrtPriceLimitX96: 0

/**
 * Real encoded calldata for Uniswap V3 SwapRouter02 exactInputSingle (no deadline in struct).
 * exactInputSingle((tokenIn, tokenOut, fee, recipient, amountIn, amountOutMin, sqrtPriceLimitX96))
 */
const V3_ROUTER02_EXACT_INPUT_SINGLE_CALLDATA =
  '0x04e45aaf' + // selector (Router02)
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // tokenIn: WETH
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // tokenOut: USDC
  '0000000000000000000000000000000000000000000000000000000000000bb8' + // fee: 3000 (0.3%)
  '0000000000000000000000001234567890123456789012345678901234567890' + // recipient
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amountIn: 1 ETH
  '0000000000000000000000000000000000000000000000000000000035a4e900' + // amountOutMinimum: ~900 USDC
  '0000000000000000000000000000000000000000000000000000000000000000'; // sqrtPriceLimitX96: 0

/**
 * Real encoded calldata for Uniswap V3 exactInput (multi-hop with encoded path).
 * Path encoding: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes) + ...
 * WETH -> USDC path with 0.3% fee = WETH + 0x000bb8 + USDC
 */
const V3_EXACT_INPUT_CALLDATA =
  '0xc04b8d59' + // selector
  '0000000000000000000000000000000000000000000000000000000000000020' + // offset to tuple
  '0000000000000000000000000000000000000000000000000000000000000080' + // offset to path
  '0000000000000000000000001234567890123456789012345678901234567890' + // recipient
  '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amountIn: 1 ETH
  '0000000000000000000000000000000000000000000000000000000035a4e900' + // amountOutMinimum: ~900 USDC
  '000000000000000000000000000000000000000000000000000000000000002b' + // path length: 43 bytes
  // Path: WETH (20) + fee (3) + USDC (20) = 43 bytes
  'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH (no 0x prefix in path)
  '000bb8' + // fee 3000
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // USDC
  '00000000000000000000000000000000000000000000'; // padding

/**
 * Real encoded calldata for Curve exchange (3pool).
 * exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)
 * Swap DAI (index 0) to USDC (index 1)
 */
const CURVE_EXCHANGE_CALLDATA =
  '0x3df02124' + // selector for exchange(int128,int128,uint256,uint256)
  '0000000000000000000000000000000000000000000000000000000000000000' + // i: 0 (DAI)
  '0000000000000000000000000000000000000000000000000000000000000001' + // j: 1 (USDC)
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // dx: 1 DAI (18 decimals)
  '00000000000000000000000000000000000000000000000000000000000f4240'; // min_dy: 1 USDC (6 decimals)

/**
 * Real encoded calldata for Curve exchange_underlying (3pool).
 * exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)
 */
const CURVE_EXCHANGE_UNDERLYING_CALLDATA =
  '0xa6417ed6' + // selector for exchange_underlying
  '0000000000000000000000000000000000000000000000000000000000000000' + // i: 0 (DAI)
  '0000000000000000000000000000000000000000000000000000000000000002' + // j: 2 (USDT)
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // dx: 1 DAI
  '00000000000000000000000000000000000000000000000000000000000f4240'; // min_dy: 1 USDT

/**
 * Curve Router-NG exchange calldata.
 * exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _expected, address[5] _pools)
 */
const CURVE_ROUTER_EXCHANGE_CALLDATA =
  '0x37ed3a7a' + // selector for exchange on Router-NG
  // This is a complex multi-pool routing call - simplified for testing
  '0000000000000000000000006b175474e89094c44da98b954eeadcb5c5e818' + // route[0]: DAI
  '000000000000000000000000bebc44782c7db0a1a60cb6fe97d0b483032ff1c7' + // route[1]: 3pool
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // route[2]: USDC (output)
  '0000000000000000000000000000000000000000000000000000000000000000'.repeat(8) + // remaining route slots
  // swap_params - 5x5 array (simplified)
  '0000000000000000000000000000000000000000000000000000000000000000' + // i
  '0000000000000000000000000000000000000000000000000000000000000001' + // j
  '0000000000000000000000000000000000000000000000000000000000000001' + // swap_type
  '0000000000000000000000000000000000000000000000000000000000000000'.repeat(22) + // rest of params
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amount: 1 token
  '00000000000000000000000000000000000000000000000000000000000f4240' + // expected min
  '000000000000000000000000bebc44782c7db0a1a60cb6fe97d0b483032ff1c7' + // pools[0]: 3pool
  '0000000000000000000000000000000000000000000000000000000000000000'.repeat(4); // remaining pools

// =============================================================================
// UNISWAP V2 DECODER TESTS
// =============================================================================

describe('UniswapV2Decoder', () => {
  let decoder: UniswapV2Decoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    logger.clear();
    decoder = new UniswapV2Decoder(logger as unknown as Logger);
  });

  describe('canDecode', () => {
    it('should return true for swapExactTokensForTokens selector', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return true for swapExactETHForTokens selector', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_ETH_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return true for swapExactTokensForETH selector', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_ETH_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return true for swapTokensForExactTokens selector', () => {
      const tx = createMockTx({
        input: SWAP_TOKENS_FOR_EXACT_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return false for unknown selector', () => {
      const tx = createMockTx({
        input: '0x12345678' + '00'.repeat(100),
        to: UNISWAP_V2_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(false);
    });

    it('should return false for empty input', () => {
      const tx = createMockTx({ input: '0x' });
      expect(decoder.canDecode(tx)).toBe(false);
    });

    it('should return false for input shorter than 4 bytes', () => {
      const tx = createMockTx({ input: '0x38ed' });
      expect(decoder.canDecode(tx)).toBe(false);
    });
  });

  describe('decode', () => {
    it('should decode swapExactTokensForTokens correctly', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV2');
      expect(result!.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
      expect(result!.amountIn).toBe(BigInt('1000000000000000000')); // 1 ETH
      expect(result!.expectedAmountOut).toBe(BigInt('900000000')); // ~900 USDC
      expect(result!.path.length).toBe(2);
      expect(result!.hash).toBe(tx.hash);
      expect(result!.sender).toBe(tx.from);
    });

    it('should decode swapExactETHForTokens correctly', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_ETH_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
        value: '0x0de0b6b3a7640000', // 1 ETH
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV2');
      expect(result!.amountIn).toBe(BigInt('1000000000000000000')); // Value from tx
      expect(result!.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
    });

    it('should decode swapExactTokensForETH correctly', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_ETH_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV2');
      expect(result!.tokenIn.toLowerCase()).toBe(USDC.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.amountIn).toBe(BigInt('1000000000')); // 1000 USDC
    });

    it('should decode swapTokensForExactTokens correctly', () => {
      const tx = createMockTx({
        input: SWAP_TOKENS_FOR_EXACT_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV2');
      // For exact output swaps, amountIn is the max input
      expect(result!.expectedAmountOut).toBe(BigInt('1000000000')); // 1000 USDC (exact)
      expect(result!.amountIn).toBe(BigInt('1100000000000000000')); // ~1.1 ETH max
    });

    it('should handle multi-hop paths', () => {
      // Create a 3-hop path: WETH -> USDC -> DAI
      const multiHopCalldata =
        '0x38ed1739' + // selector
        '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amountIn
        '0000000000000000000000000000000000000000000000000000000035a4e900' + // amountOutMin
        '00000000000000000000000000000000000000000000000000000000000000a0' + // path offset
        '0000000000000000000000001234567890123456789012345678901234567890' + // to
        '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
        '0000000000000000000000000000000000000000000000000000000000000003' + // path length: 3
        '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH
        '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // USDC
        '0000000000000000000000006b175474e89094c44da98b954eeadcdeb5c5e818'; // DAI (fixed - 64 hex chars)

      const tx = createMockTx({
        input: multiHopCalldata,
        to: UNISWAP_V2_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.path.length).toBe(3);
      expect(result!.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toContain('6b175474'); // DAI
    });

    it('should extract gas price correctly', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
        gasPrice: '0x12a05f200', // 5 gwei
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.gasPrice).toBe(BigInt('5000000000')); // 5 gwei
    });

    it('should extract EIP-1559 gas parameters', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
        maxFeePerGas: '0x12a05f200', // 5 gwei
        maxPriorityFeePerGas: '0x3b9aca00', // 1 gwei
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.maxFeePerGas).toBe(BigInt('5000000000'));
      expect(result!.maxPriorityFeePerGas).toBe(BigInt('1000000000'));
    });

    it('should parse nonce correctly', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
        nonce: '0x2a', // 42
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.nonce).toBe(42);
    });

    it('should return null for invalid calldata', () => {
      const tx = createMockTx({
        input: '0x38ed1739' + '00'.repeat(10), // Too short
        to: UNISWAP_V2_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).toBeNull();
    });

    it('should handle fee-on-transfer token selectors', () => {
      // swapExactTokensForTokensSupportingFeeOnTransferTokens
      const feeOnTransferCalldata =
        '0x5c11d795' + // selector
        '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amountIn
        '0000000000000000000000000000000000000000000000000000000035a4e900' + // amountOutMin
        '00000000000000000000000000000000000000000000000000000000000000a0' + // path offset
        '0000000000000000000000001234567890123456789012345678901234567890' + // to
        '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
        '0000000000000000000000000000000000000000000000000000000000000002' + // path length
        '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH
        '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC

      const tx = createMockTx({
        input: feeOnTransferCalldata,
        to: UNISWAP_V2_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);

      const result = decoder.decode(tx);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV2');
    });
  });

  describe('supportedChains', () => {
    it('should support Ethereum mainnet', () => {
      expect(decoder.supportedChains).toContain(1);
    });

    it('should support BSC', () => {
      expect(decoder.supportedChains).toContain(56);
    });

    it('should support Polygon', () => {
      expect(decoder.supportedChains).toContain(137);
    });

    it('should support Arbitrum', () => {
      expect(decoder.supportedChains).toContain(42161);
    });
  });
});

// =============================================================================
// UNISWAP V3 DECODER TESTS
// =============================================================================

describe('UniswapV3Decoder', () => {
  let decoder: UniswapV3Decoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    logger.clear();
    decoder = new UniswapV3Decoder(logger as unknown as Logger);
  });

  describe('canDecode', () => {
    it('should return true for exactInputSingle selector (original router)', () => {
      const tx = createMockTx({
        input: V3_EXACT_INPUT_SINGLE_CALLDATA,
        to: UNISWAP_V3_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return true for exactInputSingle selector (Router02)', () => {
      const tx = createMockTx({
        input: V3_ROUTER02_EXACT_INPUT_SINGLE_CALLDATA,
        to: UNISWAP_V3_ROUTER02,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return true for exactInput selector', () => {
      const tx = createMockTx({
        input: V3_EXACT_INPUT_CALLDATA,
        to: UNISWAP_V3_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return false for V2 selectors', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(false);
    });
  });

  describe('decode', () => {
    it('should decode exactInputSingle correctly (original router)', () => {
      const tx = createMockTx({
        input: V3_EXACT_INPUT_SINGLE_CALLDATA,
        to: UNISWAP_V3_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV3');
      expect(result!.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
      expect(result!.amountIn).toBe(BigInt('1000000000000000000')); // 1 ETH
      expect(result!.expectedAmountOut).toBe(BigInt('900000000')); // ~900 USDC
      expect(result!.path.length).toBe(2); // Single-hop has 2 tokens
    });

    it('should decode exactInputSingle correctly (Router02)', () => {
      const tx = createMockTx({
        input: V3_ROUTER02_EXACT_INPUT_SINGLE_CALLDATA,
        to: UNISWAP_V3_ROUTER02,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV3');
      expect(result!.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
    });

    // FIX 7.1: exactInput test using ethers.js for proper ABI encoding
    // Uses the Interface class to encode the struct correctly
    it('should decode exactInput with encoded path correctly', () => {
      const { Interface, solidityPacked } = require('ethers');

      // Create properly encoded path: WETH -> 0.3% fee -> USDC
      const encodedPath = solidityPacked(
        ['address', 'uint24', 'address'],
        [WETH, 3000, USDC]
      );

      // Encode the exactInput params using ABI encoder
      const iface = new Interface([
        'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) returns (uint256 amountOut)',
      ]);

      const calldata = iface.encodeFunctionData('exactInput', [{
        path: encodedPath,
        recipient: '0x1234567890123456789012345678901234567890',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        amountIn: BigInt('1000000000000000000'), // 1 ETH
        amountOutMinimum: BigInt('900000000'), // 900 USDC
      }]);

      const tx = createMockTx({
        input: calldata,
        to: UNISWAP_V3_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV3');
      expect(result!.path.length).toBe(2);
      expect(result!.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
      expect(result!.amountIn).toBe(BigInt('1000000000000000000'));
    });

    it('should decode exactOutputSingle correctly', () => {
      // exactOutputSingle selector
      const exactOutputSingleCalldata =
        '0xdb3e2198' + // selector
        '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // tokenIn: WETH
        '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // tokenOut: USDC
        '0000000000000000000000000000000000000000000000000000000000000bb8' + // fee: 3000
        '0000000000000000000000001234567890123456789012345678901234567890' + // recipient
        '0000000000000000000000000000000000000000000000000000000067890123' + // deadline
        '000000000000000000000000000000000000000000000000000000003b9aca00' + // amountOut: 1000 USDC
        '0000000000000000000000000000000000000000000000000f43fc2c04ee0000' + // amountInMaximum: ~1.1 ETH
        '0000000000000000000000000000000000000000000000000000000000000000'; // sqrtPriceLimitX96

      const tx = createMockTx({
        input: exactOutputSingleCalldata,
        to: UNISWAP_V3_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV3');
      expect(result!.expectedAmountOut).toBe(BigInt('1000000000')); // 1000 USDC exact
      expect(result!.amountIn).toBe(BigInt('1100000000000000000')); // ~1.1 ETH max
    });

    it('should return null for invalid calldata', () => {
      const tx = createMockTx({
        input: '0x414bf389' + '00'.repeat(10), // Too short
        to: UNISWAP_V3_ROUTER,
      });

      const result = decoder.decode(tx);

      expect(result).toBeNull();
    });

    it('should set appropriate deadline for Router02 (no deadline in struct)', () => {
      const tx = createMockTx({
        input: V3_ROUTER02_EXACT_INPUT_SINGLE_CALLDATA,
        to: UNISWAP_V3_ROUTER02,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      // Router02 doesn't have deadline in struct, should use a default
      expect(result!.deadline).toBeGreaterThan(0);
    });
  });

  describe('decodeV3Path', () => {
    it('should decode single-hop path', () => {
      // WETH -> 0.3% fee -> USDC
      const singleHopPath =
        'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH
        '000bb8' + // 3000 fee
        'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC

      const path = decoder.decodeV3Path('0x' + singleHopPath);

      expect(path.length).toBe(2);
      expect(path[0].toLowerCase()).toBe('0x' + 'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
      expect(path[1].toLowerCase()).toBe('0x' + 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    });

    it('should decode multi-hop path', () => {
      // WETH -> 0.3% fee -> USDC -> 0.05% fee -> DAI
      // Path format: token0 (20B) + fee (3B) + token1 (20B) + fee (3B) + token2 (20B)
      const multiHopPath =
        'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // WETH (40 hex chars)
        '000bb8' + // 3000 fee (6 hex chars)
        'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // USDC (40 hex chars)
        '0001f4' + // 500 fee (6 hex chars)
        '6b175474e89094c44da98b954eeadcdeb5c5e818'; // DAI (40 hex chars - fixed)

      const path = decoder.decodeV3Path('0x' + multiHopPath);

      expect(path.length).toBe(3);
      expect(path[0].toLowerCase()).toContain('c02aaa39');
      expect(path[1].toLowerCase()).toContain('a0b86991');
      expect(path[2].toLowerCase()).toContain('6b175474');
    });

    it('should return empty array for invalid path', () => {
      const path = decoder.decodeV3Path('0x1234'); // Too short
      expect(path.length).toBe(0);
    });
  });

  describe('supportedChains', () => {
    it('should support Ethereum mainnet', () => {
      expect(decoder.supportedChains).toContain(1);
    });

    it('should support Optimism', () => {
      expect(decoder.supportedChains).toContain(10);
    });

    it('should support Base', () => {
      expect(decoder.supportedChains).toContain(8453);
    });
  });
});

// =============================================================================
// CURVE DECODER TESTS
// =============================================================================

describe('CurveDecoder', () => {
  let decoder: CurveDecoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    logger.clear();
    decoder = new CurveDecoder(logger as unknown as Logger);
  });

  describe('canDecode', () => {
    it('should return true for exchange selector', () => {
      const tx = createMockTx({
        input: CURVE_EXCHANGE_CALLDATA,
        to: CURVE_3POOL,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return true for exchange_underlying selector', () => {
      const tx = createMockTx({
        input: CURVE_EXCHANGE_UNDERLYING_CALLDATA,
        to: CURVE_3POOL,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return false for Uniswap V2 selectors', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: CURVE_3POOL,
      });

      expect(decoder.canDecode(tx)).toBe(false);
    });
  });

  describe('decode', () => {
    it('should decode exchange correctly', () => {
      const tx = createMockTx({
        input: CURVE_EXCHANGE_CALLDATA,
        to: CURVE_3POOL,
        chainId: 1,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('curve');
      expect(result!.router).toBe(CURVE_3POOL);
      expect(result!.amountIn).toBe(BigInt('1000000000000000000')); // 1 DAI
      expect(result!.expectedAmountOut).toBe(BigInt('1000000')); // 1 USDC
      // Curve pools have indices, decoded tokens depend on pool config
      expect(result!.path.length).toBe(2);
    });

    it('should decode exchange_underlying correctly', () => {
      const tx = createMockTx({
        input: CURVE_EXCHANGE_UNDERLYING_CALLDATA,
        to: CURVE_3POOL,
        chainId: 1,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('curve');
      expect(result!.path.length).toBe(2);
    });

    it('should handle unknown pool addresses', () => {
      const tx = createMockTx({
        input: CURVE_EXCHANGE_CALLDATA,
        to: '0x' + '9'.repeat(40), // Unknown pool
        chainId: 1,
      });

      const result = decoder.decode(tx);

      // Should still decode but may not resolve token addresses
      expect(result).not.toBeNull();
      expect(result!.type).toBe('curve');
    });

    it('should extract slippage from min_dy', () => {
      const tx = createMockTx({
        input: CURVE_EXCHANGE_CALLDATA,
        to: CURVE_3POOL,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.slippageTolerance).toBeGreaterThanOrEqual(0);
    });

    it('should return null for invalid calldata', () => {
      const tx = createMockTx({
        input: '0x3df02124' + '00'.repeat(10), // Too short
        to: CURVE_3POOL,
      });

      const result = decoder.decode(tx);

      expect(result).toBeNull();
    });
  });

  describe('pool configuration', () => {
    it('should recognize 3pool tokens', () => {
      expect(decoder.getPoolTokens(CURVE_3POOL, 1)).toBeDefined();
    });

    it('should return token address for known pool index', () => {
      const tokens = decoder.getPoolTokens(CURVE_3POOL, 1);
      if (tokens) {
        expect(tokens[0].toLowerCase()).toContain('6b175474'); // DAI at index 0
        expect(tokens[1].toLowerCase()).toContain('a0b86991'); // USDC at index 1
        expect(tokens[2].toLowerCase()).toContain('dac17f95'); // USDT at index 2
      }
    });
  });

  describe('supportedChains', () => {
    it('should support Ethereum mainnet', () => {
      expect(decoder.supportedChains).toContain(1);
    });

    it('should support Arbitrum', () => {
      expect(decoder.supportedChains).toContain(42161);
    });

    it('should support Polygon', () => {
      expect(decoder.supportedChains).toContain(137);
    });
  });
});

// =============================================================================
// DECODER REGISTRY TESTS
// =============================================================================

describe('DecoderRegistry', () => {
  let registry: DecoderRegistry;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    logger.clear();
    registry = createDecoderRegistry(logger as unknown as Logger);
  });

  describe('createDecoderRegistry', () => {
    it('should create registry with all decoders', () => {
      expect(registry).toBeDefined();
      const stats = registry.getStats();
      expect(stats.decoderCount).toBeGreaterThanOrEqual(3); // V2, V3, Curve
    });

    it('should register known router addresses', () => {
      const stats = registry.getStats();
      expect(stats.routerCount).toBeGreaterThan(0);
    });
  });

  describe('decode', () => {
    it('should route Uniswap V2 transactions to V2 decoder', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      const result = registry.decode(tx, 1);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV2');
    });

    it('should route Uniswap V3 transactions to V3 decoder', () => {
      const tx = createMockTx({
        input: V3_EXACT_INPUT_SINGLE_CALLDATA,
        to: UNISWAP_V3_ROUTER,
      });

      const result = registry.decode(tx, 1);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('uniswapV3');
    });

    it('should route Curve transactions to Curve decoder', () => {
      const tx = createMockTx({
        input: CURVE_EXCHANGE_CALLDATA,
        to: CURVE_3POOL,
      });

      const result = registry.decode(tx, 1);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('curve');
    });

    it('should return null for unknown selectors', () => {
      const tx = createMockTx({
        input: '0x12345678' + '00'.repeat(100),
      });

      const result = registry.decode(tx, 1);

      expect(result).toBeNull();
    });

    it('should return null for empty input', () => {
      const tx = createMockTx({ input: '0x' });

      const result = registry.decode(tx, 1);

      expect(result).toBeNull();
    });

    it('should handle chain ID as string', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
      });

      const result = registry.decode(tx, 'ethereum');

      expect(result).not.toBeNull();
      expect(result!.chainId).toBe(1);
    });

    it('should set chainId from transaction when provided', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: UNISWAP_V2_ROUTER,
        chainId: 56, // BSC
      });

      const result = registry.decode(tx, 56);

      expect(result).not.toBeNull();
      expect(result!.chainId).toBe(56);
    });

    it('should handle decode errors gracefully', () => {
      const tx = createMockTx({
        input: '0x38ed1739' + '00'.repeat(10), // Invalid length
        to: UNISWAP_V2_ROUTER,
      });

      // Should not throw
      const result = registry.decode(tx, 1);
      expect(result).toBeNull();
    });
  });

  describe('getDecoderForSelector', () => {
    it('should return V2 decoder for V2 selectors', () => {
      const decoder = registry.getDecoderForSelector('0x38ed1739');
      expect(decoder).toBeDefined();
      expect(decoder!.type).toBe('uniswapV2');
    });

    it('should return V3 decoder for V3 selectors', () => {
      const decoder = registry.getDecoderForSelector('0x414bf389');
      expect(decoder).toBeDefined();
      expect(decoder!.type).toBe('uniswapV3');
    });

    it('should return Curve decoder for Curve selectors', () => {
      const decoder = registry.getDecoderForSelector('0x3df02124');
      expect(decoder).toBeDefined();
      expect(decoder!.type).toBe('curve');
    });

    it('should return undefined for unknown selectors', () => {
      const decoder = registry.getDecoderForSelector('0x12345678');
      expect(decoder).toBeUndefined();
    });
  });

  describe('registerDecoder', () => {
    it('should allow registering custom decoders', () => {
      const customDecoder: SwapDecoder = {
        type: '1inch' as SwapRouterType,
        name: 'Custom 1inch Decoder',
        supportedChains: [1],
        canDecode: (_tx: RawPendingTransaction): boolean => true,
        decode: (_tx: RawPendingTransaction): PendingSwapIntent | null => null,
      };

      registry.registerDecoder('0xabcdef12', customDecoder);

      const decoder = registry.getDecoderForSelector('0xabcdef12');
      expect(decoder).toBe(customDecoder);
    });
  });

  describe('getRouterType', () => {
    it('should return router type for known addresses', () => {
      const type = registry.getRouterType(UNISWAP_V2_ROUTER);
      expect(type).toBe('uniswapV2');
    });

    it('should return router type case-insensitively', () => {
      const type = registry.getRouterType(UNISWAP_V2_ROUTER.toLowerCase());
      expect(type).toBe('uniswapV2');
    });

    it('should return undefined for unknown addresses', () => {
      const type = registry.getRouterType('0x' + '0'.repeat(40));
      expect(type).toBeUndefined();
    });
  });

  describe('getSupportedSelectors', () => {
    it('should return all supported selectors', () => {
      const selectors = registry.getSupportedSelectors();
      expect(selectors.length).toBeGreaterThan(0);
      expect(selectors).toContain('0x38ed1739'); // V2
      expect(selectors).toContain('0x414bf389'); // V3
      expect(selectors).toContain('0x3df02124'); // Curve
    });
  });
});

// =============================================================================
// SWAP FUNCTION SELECTORS TESTS
// =============================================================================

describe('SWAP_FUNCTION_SELECTORS', () => {
  it('should export Uniswap V2 selectors', () => {
    expect(SWAP_FUNCTION_SELECTORS['0x38ed1739']).toBeDefined();
    expect(SWAP_FUNCTION_SELECTORS['0x38ed1739'].method).toBe('swapExactTokensForTokens');
  });

  it('should export Uniswap V3 selectors', () => {
    expect(SWAP_FUNCTION_SELECTORS['0x414bf389']).toBeDefined();
    expect(SWAP_FUNCTION_SELECTORS['0x414bf389'].method).toBe('exactInputSingle');
  });

  it('should export Curve selectors', () => {
    expect(SWAP_FUNCTION_SELECTORS['0x3df02124']).toBeDefined();
    expect(SWAP_FUNCTION_SELECTORS['0x3df02124'].method).toBe('exchange');
  });

  it('should export 1inch selectors', () => {
    expect(SWAP_FUNCTION_SELECTORS['0x12aa3caf']).toBeDefined();
    expect(SWAP_FUNCTION_SELECTORS['0x12aa3caf'].method).toBe('swap');
  });

  it('should include router types for each selector', () => {
    for (const [selector, info] of Object.entries(SWAP_FUNCTION_SELECTORS)) {
      expect(info.routerTypes).toBeDefined();
      expect(info.routerTypes.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// 1INCH DECODER TESTS
// =============================================================================

/**
 * 1inch AggregatorV5 Router address on Ethereum mainnet.
 */
const ONEINCH_ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582';

/**
 * 1inch swap calldata example.
 * swap(executor, (srcToken, dstToken, srcReceiver, dstReceiver, amount, minReturnAmount, flags), permit, data)
 */
const ONEINCH_SWAP_CALLDATA =
  '0x12aa3caf' + // selector
  '0000000000000000000000001136b25047e142fa3018184793aec68fbb173ce4' + // executor
  // SwapDescription tuple:
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // srcToken: WETH
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // dstToken: USDC
  '0000000000000000000000001111111254eeb25477b68fb85ed929f73a960582' + // srcReceiver
  '0000000000000000000000001234567890123456789012345678901234567890' + // dstReceiver
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amount: 1 ETH
  '0000000000000000000000000000000000000000000000000000000035a4e900' + // minReturnAmount: ~900 USDC
  '0000000000000000000000000000000000000000000000000000000000000000' + // flags
  '00000000000000000000000000000000000000000000000000000000000000e0' + // permit offset
  '0000000000000000000000000000000000000000000000000000000000000100' + // data offset
  '0000000000000000000000000000000000000000000000000000000000000000' + // permit length
  '0000000000000000000000000000000000000000000000000000000000000000'; // data length

import { OneInchDecoder } from '../../src/decoders';

describe('OneInchDecoder', () => {
  let decoder: OneInchDecoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    logger.clear();
    decoder = new OneInchDecoder(logger as unknown as Logger);
  });

  describe('canDecode', () => {
    it('should return true for swap selector', () => {
      const tx = createMockTx({
        input: ONEINCH_SWAP_CALLDATA,
        to: ONEINCH_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return true for unoswap selector', () => {
      // unoswap selector
      const tx = createMockTx({
        input: '0x0502b1c5' + '00'.repeat(100),
        to: ONEINCH_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });

    it('should return false for V2 selectors', () => {
      const tx = createMockTx({
        input: SWAP_EXACT_TOKENS_FOR_TOKENS_CALLDATA,
        to: ONEINCH_ROUTER,
      });

      expect(decoder.canDecode(tx)).toBe(false);
    });
  });

  describe('decode', () => {
    // FIX 7.1: 1inch swap test using ethers.js for proper ABI encoding
    it('should decode swap correctly', () => {
      const { Interface, AbiCoder } = require('ethers');

      // 1inch swap ABI with the SwapDescription struct
      const iface = new Interface([
        `function swap(
          address executor,
          (
            address srcToken,
            address dstToken,
            address payable srcReceiver,
            address payable dstReceiver,
            uint256 amount,
            uint256 minReturnAmount,
            uint256 flags
          ) desc,
          bytes permit,
          bytes data
        ) returns (uint256 returnAmount, uint256 spentAmount)`
      ]);

      const calldata = iface.encodeFunctionData('swap', [
        '0x1136b25047e142fa3018184793aec68fbb173ce4', // executor
        {
          srcToken: WETH,
          dstToken: USDC,
          srcReceiver: '0x1111111254eeb25477b68fb85ed929f73a960582',
          dstReceiver: '0x1234567890123456789012345678901234567890',
          amount: BigInt('1000000000000000000'), // 1 ETH
          minReturnAmount: BigInt('900000000'), // ~900 USDC
          flags: BigInt(0),
        },
        '0x', // empty permit
        '0x', // empty data
      ]);

      const tx = createMockTx({
        input: calldata,
        to: ONEINCH_ROUTER,
        chainId: 1,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('1inch');
      expect(result!.router).toBe(ONEINCH_ROUTER);
      expect(result!.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
      expect(result!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
      expect(result!.amountIn).toBe(BigInt('1000000000000000000')); // 1 ETH
      expect(result!.expectedAmountOut).toBe(BigInt('900000000')); // ~900 USDC
    });

    it('should handle invalid calldata gracefully', () => {
      const tx = createMockTx({
        input: '0x12aa3caf' + '00'.repeat(10), // Too short
        to: ONEINCH_ROUTER,
      });

      const result = decoder.decode(tx);
      expect(result).toBeNull();
    });
  });

  describe('supportedChains', () => {
    it('should support Ethereum mainnet', () => {
      expect(decoder.supportedChains).toContain(1);
    });

    it('should support BSC', () => {
      expect(decoder.supportedChains).toContain(56);
    });

    it('should support Arbitrum', () => {
      expect(decoder.supportedChains).toContain(42161);
    });
  });
});

// =============================================================================
// CURVE CRYPTOSWAP TESTS
// =============================================================================

/**
 * Curve Tricrypto2 pool address.
 */
const CURVE_TRICRYPTO2 = '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46';

/**
 * CryptoSwap exchange calldata (uint256 indices).
 * exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
 */
const CURVE_CRYPTOSWAP_CALLDATA =
  '0x5b41b908' + // selector for exchange(uint256,uint256,uint256,uint256)
  '0000000000000000000000000000000000000000000000000000000000000000' + // i: 0 (USDT)
  '0000000000000000000000000000000000000000000000000000000000000002' + // j: 2 (WETH)
  '00000000000000000000000000000000000000000000000000000000000f4240' + // dx: 1 USDT (6 decimals)
  '0000000000000000000000000000000000000000000000000000b5e620f48000'; // min_dy

describe('CurveDecoder - CryptoSwap', () => {
  let decoder: CurveDecoder;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    logger.clear();
    decoder = new CurveDecoder(logger as unknown as Logger);
  });

  describe('CryptoSwap uint256 indices', () => {
    it('should decode CryptoSwap exchange with uint256 indices', () => {
      const tx = createMockTx({
        input: CURVE_CRYPTOSWAP_CALLDATA,
        to: CURVE_TRICRYPTO2,
        chainId: 1,
      });

      const result = decoder.decode(tx);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('curve');
      expect(result!.amountIn).toBe(BigInt('1000000')); // 1 USDT
      expect(result!.path.length).toBe(2);
    });

    it('should recognize CryptoSwap selector', () => {
      const tx = createMockTx({
        input: CURVE_CRYPTOSWAP_CALLDATA,
        to: CURVE_TRICRYPTO2,
      });

      expect(decoder.canDecode(tx)).toBe(true);
    });
  });
});

// =============================================================================
// CHAIN-AWARE ROUTER LOOKUP TESTS
// =============================================================================

describe('DecoderRegistry - Chain-aware router lookup', () => {
  let registry: DecoderRegistry;
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    logger.clear();
    registry = createDecoderRegistry(logger as unknown as Logger);
  });

  describe('getRouterTypeForChain', () => {
    it('should return router type for Ethereum mainnet', () => {
      const type = registry.getRouterTypeForChain(UNISWAP_V2_ROUTER, 1);
      expect(type).toBe('uniswapV2');
    });

    it('should return router type using chain name', () => {
      const type = registry.getRouterTypeForChain(UNISWAP_V2_ROUTER, 'ethereum');
      expect(type).toBe('uniswapV2');
    });

    it('should return undefined for unknown chain', () => {
      const type = registry.getRouterTypeForChain(UNISWAP_V2_ROUTER, 999999);
      expect(type).toBeUndefined();
    });

    it('should return undefined for unknown address on known chain', () => {
      const type = registry.getRouterTypeForChain('0x' + '0'.repeat(40), 1);
      expect(type).toBeUndefined();
    });

    it('should handle case-insensitive address lookup', () => {
      const type = registry.getRouterTypeForChain(UNISWAP_V2_ROUTER.toLowerCase(), 'ethereum');
      expect(type).toBe('uniswapV2');
    });
  });

  describe('getStats', () => {
    it('should include chain count in stats', () => {
      const stats = registry.getStats();
      expect(stats.chainCount).toBeGreaterThan(0);
    });
  });
});
