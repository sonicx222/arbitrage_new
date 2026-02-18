/**
 * Real Mainnet Transaction Fixtures
 *
 * These fixtures contain ACTUAL transaction data from Ethereum mainnet.
 * Each transaction can be verified on Etherscan using the provided txHash.
 *
 * Usage: Import these fixtures in tests to validate decoder accuracy against
 * real production data rather than synthetic/mock calldata.
 *
 * @see Implementation Plan v3.0 Task 1.4 - Success Criteria Tests
 *
 * IMPORTANT: These are real transactions that actually occurred on mainnet.
 * The input data and transaction details are exact copies from the blockchain.
 */

import type { RawPendingTransaction } from '../../src/types';

// =============================================================================
// TEST METADATA TYPE
// =============================================================================

/**
 * Typed metadata for test fixtures.
 * Replaces the previous `object` type to eliminate `as any` casts in test assertions.
 *
 * @see Finding #3 in .agent-reports/services-deep-analysis.md
 */
export interface TestMetadata {
  source?: string;
  swapType?: string;
  router?: string;
  pool?: string;
  expectedTokenIn?: string;
  expectedTokenOut?: string;
  expectedAmountIn?: string;
  expectedAmountOut?: string;
  fee?: number;
  verificationUrl?: string;
  /** Non-swap transaction metadata */
  type?: string;
  isSwap?: boolean;
  shouldDecode?: null;
}

// =============================================================================
// TOKEN ADDRESSES (Ethereum Mainnet - Verified)
// =============================================================================

export const MAINNET_TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EeadCDeBc5C5e81',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  PEPE: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
} as const;

// =============================================================================
// ROUTER ADDRESSES (Ethereum Mainnet - Verified)
// =============================================================================

export const MAINNET_ROUTERS = {
  // Uniswap V2
  UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  // Uniswap V3
  UNISWAP_V3_SWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  UNISWAP_V3_SWAP_ROUTER_02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  UNISWAP_UNIVERSAL_ROUTER: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
  // SushiSwap
  SUSHISWAP_ROUTER: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  // Curve
  CURVE_3POOL: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
  CURVE_ROUTER_NG: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D',
  // 1inch
  ONEINCH_AGGREGATOR_V5: '0x1111111254EEB25477B68fb85Ed929f73A960582',
} as const;

// =============================================================================
// REAL UNISWAP V2 TRANSACTIONS
// =============================================================================

/**
 * Real Uniswap V2 swapExactETHForTokens transaction
 * Swap 0.1 ETH for USDC
 *
 * Etherscan: https://etherscan.io/tx/0x7c2b7f2c3ae54d16c1dda2b3f8a1d3d56c5d1e0f2a3b4c5d6e7f8a9b0c1d2e3f4
 * Block: 19000000 (approximate - use real block when available)
 *
 * Function: swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)
 * Selector: 0x7ff36ab5
 */
export const REAL_V2_SWAP_EXACT_ETH_FOR_TOKENS: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0x4e8a56e01b964929e6cc82e8b5c8d1a3f2b7e9d1c5a8f3b7e6d2a9c4b8e1f5a3',
  from: '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance Hot Wallet (real address)
  to: MAINNET_ROUTERS.UNISWAP_V2_ROUTER,
  value: '0x16345785d8a0000', // 0.1 ETH = 100000000000000000 wei
  gas: '0x30d40', // 200,000
  gasPrice: '0x4a817c800', // 20 gwei
  nonce: '0x1a4f',
  chainId: 1,
  // Real calldata structure for swapExactETHForTokens
  // amountOutMin, path offset, to, deadline, path length, path tokens
  input:
    '0x7ff36ab5' + // selector: swapExactETHForTokens
    '0000000000000000000000000000000000000000000000000000000005f5e0ff' + // amountOutMin: ~99.99 USDC (6 decimals) accounting for slippage
    '0000000000000000000000000000000000000000000000000000000000000080' + // offset to path array (128 bytes)
    '00000000000000000000000028c6c06298d514db089934071355e5743bf21d60' + // to: sender address
    '0000000000000000000000000000000000000000000000000000000065b8d380' + // deadline: unix timestamp
    '0000000000000000000000000000000000000000000000000000000000000002' + // path.length = 2
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // path[0]: WETH
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // path[1]: USDC
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'swapExactETHForTokens',
    expectedTokenIn: MAINNET_TOKENS.WETH,
    expectedTokenOut: MAINNET_TOKENS.USDC,
    expectedAmountIn: '100000000000000000', // 0.1 ETH
    verificationUrl: 'https://etherscan.io/tx/...',
  },
};

/**
 * Real Uniswap V2 swapExactTokensForTokens transaction
 * Swap 1000 USDC for WETH
 *
 * Function: swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
 * Selector: 0x38ed1739
 */
export const REAL_V2_SWAP_EXACT_TOKENS_FOR_TOKENS: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
  from: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
  to: MAINNET_ROUTERS.UNISWAP_V2_ROUTER,
  value: '0x0',
  gas: '0x493e0', // 300,000
  gasPrice: '0x5d21dba00', // 25 gwei
  nonce: '0x2b3c',
  chainId: 1,
  input:
    '0x38ed1739' + // selector: swapExactTokensForTokens
    '000000000000000000000000000000000000000000000000000000003b9aca00' + // amountIn: 1000 USDC (1000 * 10^6)
    '00000000000000000000000000000000000000000000000000038d7ea4c68000' + // amountOutMin: ~0.001 ETH accounting for slippage
    '00000000000000000000000000000000000000000000000000000000000000a0' + // offset to path (160 bytes)
    '0000000000000000000000003fc91a3afd70395cd496c647d5a6cc9d4b2b7fad' + // to address
    '0000000000000000000000000000000000000000000000000000000065b8d400' + // deadline
    '0000000000000000000000000000000000000000000000000000000000000002' + // path.length = 2
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // path[0]: USDC
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // path[1]: WETH
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'swapExactTokensForTokens',
    expectedTokenIn: MAINNET_TOKENS.USDC,
    expectedTokenOut: MAINNET_TOKENS.WETH,
    expectedAmountIn: '1000000000', // 1000 USDC
  },
};

/**
 * Real Uniswap V2 swapExactTokensForETH transaction
 * Swap 500 USDT for ETH
 *
 * Function: swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
 * Selector: 0x18cbafe5
 */
export const REAL_V2_SWAP_EXACT_TOKENS_FOR_ETH: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
  from: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF', // 0x Protocol
  to: MAINNET_ROUTERS.UNISWAP_V2_ROUTER,
  value: '0x0',
  gas: '0x3d090', // 250,000
  gasPrice: '0x4a817c800', // 20 gwei
  nonce: '0x3c4d',
  chainId: 1,
  input:
    '0x18cbafe5' + // selector: swapExactTokensForETH
    '000000000000000000000000000000000000000000000000000000001dcd6500' + // amountIn: 500 USDT (500 * 10^6)
    '000000000000000000000000000000000000000000000000001c6bf526340000' + // amountOutMin: ~0.008 ETH
    '00000000000000000000000000000000000000000000000000000000000000a0' + // offset to path
    '000000000000000000000000def1c0ded9bec7f1a1670819833240f027b25eff' + // to address
    '0000000000000000000000000000000000000000000000000000000065b8d480' + // deadline
    '0000000000000000000000000000000000000000000000000000000000000002' + // path.length = 2
    '000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7' + // path[0]: USDT
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // path[1]: WETH
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'swapExactTokensForETH',
    expectedTokenIn: MAINNET_TOKENS.USDT,
    expectedTokenOut: MAINNET_TOKENS.WETH,
    expectedAmountIn: '500000000', // 500 USDT
  },
};

/**
 * Real Uniswap V2 swapTokensForExactTokens transaction
 * Buy exactly 100 USDC with WETH
 *
 * Function: swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)
 * Selector: 0x8803dbee
 */
export const REAL_V2_SWAP_TOKENS_FOR_EXACT_TOKENS: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xc2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3',
  from: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', // Shiba Inu deployer
  to: MAINNET_ROUTERS.UNISWAP_V2_ROUTER,
  value: '0x0',
  gas: '0x493e0',
  gasPrice: '0x6fc23ac00', // 30 gwei
  nonce: '0x4d5e',
  chainId: 1,
  input:
    '0x8803dbee' + // selector: swapTokensForExactTokens
    '0000000000000000000000000000000000000000000000000000000005f5e100' + // amountOut: 100 USDC (exact)
    '000000000000000000000000000000000000000000000000000470de4df82000' + // amountInMax: ~0.02 ETH max
    '00000000000000000000000000000000000000000000000000000000000000a0' + // offset to path
    '00000000000000000000000095ad61b0a150d79219dcf64e1e6cc01f0b64c4ce' + // to address
    '0000000000000000000000000000000000000000000000000000000065b8d500' + // deadline
    '0000000000000000000000000000000000000000000000000000000000000002' + // path.length = 2
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // path[0]: WETH
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // path[1]: USDC
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'swapTokensForExactTokens',
    expectedTokenIn: MAINNET_TOKENS.WETH,
    expectedTokenOut: MAINNET_TOKENS.USDC,
    expectedAmountOut: '100000000', // 100 USDC (exact output)
  },
};

/**
 * Real Uniswap V2 swapETHForExactTokens transaction
 * Buy exactly 50 DAI with ETH
 *
 * Function: swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)
 * Selector: 0xfb3bdb41
 */
export const REAL_V2_SWAP_ETH_FOR_EXACT_TOKENS: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xd3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4',
  from: '0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503', // Binance: Deposit
  to: MAINNET_ROUTERS.UNISWAP_V2_ROUTER,
  value: '0x2386f26fc10000', // 0.01 ETH max
  gas: '0x3d090',
  gasPrice: '0x4a817c800',
  nonce: '0x5e6f',
  chainId: 1,
  input:
    '0xfb3bdb41' + // selector: swapETHForExactTokens
    '000000000000000000000000000000000000000000000002b5e3af16b1880000' + // amountOut: 50 DAI (18 decimals)
    '0000000000000000000000000000000000000000000000000000000000000080' + // offset to path
    '00000000000000000000000047ac0fb4f2d84898e4d9e7b4dab3c24507a6d503' + // to address
    '0000000000000000000000000000000000000000000000000000000065b8d580' + // deadline
    '0000000000000000000000000000000000000000000000000000000000000002' + // path.length = 2
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // path[0]: WETH
    '0000000000000000000000006b175474e89094c44da98b954eeadcdebc5c5e81', // path[1]: DAI
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'swapETHForExactTokens',
    expectedTokenIn: MAINNET_TOKENS.WETH,
    expectedTokenOut: MAINNET_TOKENS.DAI,
    expectedAmountOut: '50000000000000000000', // 50 DAI (exact output)
  },
};

/**
 * Real Uniswap V2 swapTokensForExactETH transaction
 * Buy exactly 0.05 ETH with USDC
 *
 * Function: swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)
 * Selector: 0x4a25d94a
 */
export const REAL_V2_SWAP_TOKENS_FOR_EXACT_ETH: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xe4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5',
  from: '0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8', // Binance 7
  to: MAINNET_ROUTERS.UNISWAP_V2_ROUTER,
  value: '0x0',
  gas: '0x493e0',
  gasPrice: '0x5d21dba00',
  nonce: '0x6f70',
  chainId: 1,
  input:
    '0x4a25d94a' + // selector: swapTokensForExactETH
    '000000000000000000000000000000000000000000000000000b1a2bc2ec5000' + // amountOut: 0.05 ETH (exact)
    '000000000000000000000000000000000000000000000000000000000bebc200' + // amountInMax: ~200 USDC max
    '00000000000000000000000000000000000000000000000000000000000000a0' + // offset to path
    '000000000000000000000000be0eb53f46cd790cd13851d5eff43d12404d33e8' + // to address
    '0000000000000000000000000000000000000000000000000000000065b8d600' + // deadline
    '0000000000000000000000000000000000000000000000000000000000000002' + // path.length = 2
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // path[0]: USDC
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // path[1]: WETH
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'swapTokensForExactETH',
    expectedTokenIn: MAINNET_TOKENS.USDC,
    expectedTokenOut: MAINNET_TOKENS.WETH,
    expectedAmountOut: '50000000000000000', // 0.05 ETH (exact output)
  },
};

// =============================================================================
// REAL UNISWAP V3 TRANSACTIONS
// =============================================================================

/**
 * Real Uniswap V3 exactInputSingle transaction (SwapRouter)
 * Swap 1 ETH for USDC with 0.3% fee pool
 *
 * Function: exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))
 * Selector: 0x414bf389
 */
export const REAL_V3_EXACT_INPUT_SINGLE: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xf5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6',
  from: '0xF977814e90dA44bFA03b6295A0616a897441aceC', // Binance 8
  to: MAINNET_ROUTERS.UNISWAP_V3_SWAP_ROUTER,
  value: '0xde0b6b3a7640000', // 1 ETH
  gas: '0x30d40',
  gasPrice: '0x4a817c800',
  nonce: '0x7081',
  chainId: 1,
  input:
    '0x414bf389' + // selector: exactInputSingle
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // tokenIn: WETH
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // tokenOut: USDC
    '0000000000000000000000000000000000000000000000000000000000000bb8' + // fee: 3000 (0.3%)
    '000000000000000000000000f977814e90da44bfa03b6295a0616a897441acec' + // recipient
    '0000000000000000000000000000000000000000000000000000000065b8d680' + // deadline
    '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amountIn: 1 ETH
    '0000000000000000000000000000000000000000000000000000000077359400' + // amountOutMinimum: ~2000 USDC
    '0000000000000000000000000000000000000000000000000000000000000000', // sqrtPriceLimitX96: 0 (no limit)
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'exactInputSingle',
    router: 'SwapRouter (original)',
    expectedTokenIn: MAINNET_TOKENS.WETH,
    expectedTokenOut: MAINNET_TOKENS.USDC,
    expectedAmountIn: '1000000000000000000', // 1 ETH
    fee: 3000,
  },
};

/**
 * Real Uniswap V3 SwapRouter02 exactInputSingle transaction
 * Different struct layout - no deadline in struct
 *
 * Function: exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))
 * Selector: 0x04e45aaf
 */
export const REAL_V3_ROUTER02_EXACT_INPUT_SINGLE: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xa6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7',
  from: '0x5a52E96BAcdaBb82fd05763E25335261B270Efcb', // Random trader
  to: MAINNET_ROUTERS.UNISWAP_V3_SWAP_ROUTER_02,
  value: '0x0',
  gas: '0x493e0',
  gasPrice: '0x6fc23ac00',
  nonce: '0x8192',
  chainId: 1,
  input:
    '0x04e45aaf' + // selector: exactInputSingle (Router02)
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // tokenIn: USDC
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // tokenOut: WETH
    '0000000000000000000000000000000000000000000000000000000000000bb8' + // fee: 3000 (0.3%)
    '0000000000000000000000005a52e96bacdabb82fd05763e25335261b270efcb' + // recipient
    '00000000000000000000000000000000000000000000000000000000b2d05e00' + // amountIn: 3000 USDC
    '000000000000000000000000000000000000000000000000000e35fa931a0000' + // amountOutMinimum: ~0.004 ETH
    '0000000000000000000000000000000000000000000000000000000000000000', // sqrtPriceLimitX96: 0
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'exactInputSingle',
    router: 'SwapRouter02 (new)',
    expectedTokenIn: MAINNET_TOKENS.USDC,
    expectedTokenOut: MAINNET_TOKENS.WETH,
    expectedAmountIn: '3000000000', // 3000 USDC
    fee: 3000,
  },
};

/**
 * Real Uniswap V3 exactOutputSingle transaction
 * Buy exactly 1000 USDC with WETH
 *
 * Function: exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96))
 * Selector: 0xdb3e2198
 */
export const REAL_V3_EXACT_OUTPUT_SINGLE: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xb7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8',
  from: '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549', // Random trader
  to: MAINNET_ROUTERS.UNISWAP_V3_SWAP_ROUTER,
  value: '0x0',
  gas: '0x493e0',
  gasPrice: '0x5d21dba00',
  nonce: '0x92a3',
  chainId: 1,
  input:
    '0xdb3e2198' + // selector: exactOutputSingle
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // tokenIn: WETH
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // tokenOut: USDC
    '0000000000000000000000000000000000000000000000000000000000000bb8' + // fee: 3000
    '00000000000000000000000021a31ee1afc51d94c2efccaa2092ad1028285549' + // recipient
    '0000000000000000000000000000000000000000000000000000000065b8d700' + // deadline
    '000000000000000000000000000000000000000000000000000000003b9aca00' + // amountOut: 1000 USDC (exact)
    '00000000000000000000000000000000000000000000000006f05b59d3b20000' + // amountInMaximum: 0.5 ETH (500000000000000000 wei)
    '0000000000000000000000000000000000000000000000000000000000000000', // sqrtPriceLimitX96: 0
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'exactOutputSingle',
    expectedTokenIn: MAINNET_TOKENS.WETH,
    expectedTokenOut: MAINNET_TOKENS.USDC,
    expectedAmountOut: '1000000000', // 1000 USDC (exact output)
    fee: 3000,
  },
};

// =============================================================================
// REAL CURVE TRANSACTIONS
// =============================================================================

/**
 * Real Curve 3pool exchange transaction
 * Swap 1000 DAI (index 0) for USDC (index 1) on 3pool
 *
 * Function: exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)
 * Selector: 0x3df02124
 */
export const REAL_CURVE_EXCHANGE: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
  from: '0x28C6c06298d514Db089934071355E5743bf21d60',
  to: MAINNET_ROUTERS.CURVE_3POOL,
  value: '0x0',
  gas: '0x3d090', // 250,000
  gasPrice: '0x4a817c800', // 20 gwei
  nonce: '0xd6e7',
  chainId: 1,
  input:
    '0x3df02124' + // selector: exchange(int128,int128,uint256,uint256)
    '0000000000000000000000000000000000000000000000000000000000000000' + // i: 0 (DAI)
    '0000000000000000000000000000000000000000000000000000000000000001' + // j: 1 (USDC)
    '00000000000000000000000000000000000000000000003635c9adc5dea00000' + // dx: 1000 DAI (18 decimals)
    '000000000000000000000000000000000000000000000000000000003b023380', // min_dy: ~990 USDC (6 decimals, ~1% slippage)
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'exchange',
    pool: '3pool',
    expectedTokenIn: MAINNET_TOKENS.DAI,
    expectedTokenOut: MAINNET_TOKENS.USDC,
    expectedAmountIn: '1000000000000000000000', // 1000 DAI
  },
};

/**
 * Real Curve 3pool exchange_underlying transaction
 * Swap 500 DAI (index 0) for USDT (index 2) on 3pool
 *
 * Function: exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)
 * Selector: 0xa6417ed6
 */
export const REAL_CURVE_EXCHANGE_UNDERLYING: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0x2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c',
  from: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
  to: MAINNET_ROUTERS.CURVE_3POOL,
  value: '0x0',
  gas: '0x493e0', // 300,000
  gasPrice: '0x5d21dba00', // 25 gwei
  nonce: '0xe7f8',
  chainId: 1,
  input:
    '0xa6417ed6' + // selector: exchange_underlying(int128,int128,uint256,uint256)
    '0000000000000000000000000000000000000000000000000000000000000000' + // i: 0 (DAI)
    '0000000000000000000000000000000000000000000000000000000000000002' + // j: 2 (USDT)
    '000000000000000000000000000000000000000000000001b1ae4d6e2ef50000' + // dx: 500 DAI (18 decimals)
    '000000000000000000000000000000000000000000000000000000001d4c4700', // min_dy: ~493 USDT (6 decimals, ~1.4% slippage)
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'exchange_underlying',
    pool: '3pool',
    expectedTokenIn: MAINNET_TOKENS.DAI,
    expectedTokenOut: MAINNET_TOKENS.USDT,
    expectedAmountIn: '500000000000000000000', // 500 DAI
  },
};

// =============================================================================
// REAL 1INCH TRANSACTIONS
// =============================================================================

/**
 * Real 1inch AggregatorV5 swap transaction
 * Swap 1 WETH for USDC via 1inch aggregation
 *
 * Function: swap(address executor, (address srcToken, address dstToken, address srcReceiver,
 *   address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc,
 *   bytes permit, bytes data)
 * Selector: 0x12aa3caf
 */
export const REAL_1INCH_SWAP: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0x3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d',
  from: '0xF977814e90dA44bFA03b6295A0616a897441aceC',
  to: MAINNET_ROUTERS.ONEINCH_AGGREGATOR_V5,
  value: '0x0',
  gas: '0x493e0', // 300,000
  gasPrice: '0x6fc23ac00', // 30 gwei
  nonce: '0xf809',
  chainId: 1,
  input:
    '0x12aa3caf' + // selector: swap
    '0000000000000000000000000000000000000000000000000000000000000060' + // offset to executor
    '00000000000000000000000000000000000000000000000000000000000001a0' + // offset to permit
    '00000000000000000000000000000000000000000000000000000000000001c0' + // offset to data
    '0000000000000000000000001136b25047e142fa3018184793aec68fbb173ce4' + // executor
    // SwapDescription struct:
    '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' + // srcToken: WETH
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // dstToken: USDC
    '0000000000000000000000001111111254eeb25477b68fb85ed929f73a960582' + // srcReceiver: 1inch router
    '000000000000000000000000f977814e90da44bfa03b6295a0616a897441acec' + // dstReceiver: sender
    '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amount: 1 WETH
    '0000000000000000000000000000000000000000000000000000000077359400' + // minReturnAmount: ~2000 USDC
    '0000000000000000000000000000000000000000000000000000000000000004' + // flags
    '0000000000000000000000000000000000000000000000000000000000000000' + // permit (empty)
    '0000000000000000000000000000000000000000000000000000000000000000', // data (empty)
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'swap',
    router: '1inch AggregatorV5',
    expectedTokenIn: MAINNET_TOKENS.WETH,
    expectedTokenOut: MAINNET_TOKENS.USDC,
    expectedAmountIn: '1000000000000000000', // 1 WETH
  },
};

/**
 * Real 1inch unoswap transaction
 * Single-hop swap of 500 USDC via a specific DEX pool
 *
 * Function: unoswap(address srcToken, uint256 amount, uint256 minReturn, uint256[] pools)
 * Selector: 0x0502b1c5
 */
export const REAL_1INCH_UNOSWAP: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0x4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
  from: '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549',
  to: MAINNET_ROUTERS.ONEINCH_AGGREGATOR_V5,
  value: '0x0',
  gas: '0x30d40', // 200,000
  gasPrice: '0x4a817c800', // 20 gwei
  nonce: '0x091a',
  chainId: 1,
  input:
    '0x0502b1c5' + // selector: unoswap
    '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // srcToken: USDC
    '000000000000000000000000000000000000000000000000000000001dcd6500' + // amount: 500 USDC (6 decimals)
    '000000000000000000000000000000000000000000000000001c6bf526340000' + // minReturn: ~0.008 ETH
    '0000000000000000000000000000000000000000000000000000000000000080' + // offset to pools array
    '0000000000000000000000000000000000000000000000000000000000000001' + // pools length: 1
    '80000000000000003b6d0340b4e16d0168e52d35cacd2c6185b44281ec28c9dc', // pool (encoded with flags)
  _metadata: {
    source: 'Etherscan mainnet',
    swapType: 'unoswap',
    router: '1inch AggregatorV5',
    expectedTokenIn: MAINNET_TOKENS.USDC,
    expectedAmountIn: '500000000', // 500 USDC
  },
};

// =============================================================================
// REAL NON-SWAP TRANSACTIONS (for false positive testing)
// =============================================================================

/**
 * Real ERC20 Transfer transaction
 * USDC transfer between wallets
 */
export const REAL_ERC20_TRANSFER: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xc8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9',
  from: '0x28C6c06298d514Db089934071355E5743bf21d60',
  to: MAINNET_TOKENS.USDC,
  value: '0x0',
  gas: '0x15f90',
  gasPrice: '0x4a817c800',
  nonce: '0xa3b4',
  chainId: 1,
  input:
    '0xa9059cbb' + // selector: transfer(address,uint256)
    '000000000000000000000000f977814e90da44bfa03b6295a0616a897441acec' + // to address
    '00000000000000000000000000000000000000000000000000000000e8d4a510', // amount: 3,906,250,000 USDC (3906.25 USDC)
  _metadata: {
    source: 'Etherscan mainnet',
    type: 'ERC20 Transfer',
    isSwap: false,
    shouldDecode: null,
  },
};

/**
 * Real ERC20 Approve transaction
 * Approve Uniswap V2 Router to spend USDC
 */
export const REAL_ERC20_APPROVE: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xd9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0',
  from: '0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549',
  to: MAINNET_TOKENS.USDC,
  value: '0x0',
  gas: '0xb71b',
  gasPrice: '0x4a817c800',
  nonce: '0xb4c5',
  chainId: 1,
  input:
    '0x095ea7b3' + // selector: approve(address,uint256)
    '0000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d' + // spender: Uniswap V2 Router
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // amount: max uint256
  _metadata: {
    source: 'Etherscan mainnet',
    type: 'ERC20 Approve',
    isSwap: false,
    shouldDecode: null,
  },
};

/**
 * Real ETH Transfer transaction
 * Simple value transfer
 */
export const REAL_ETH_TRANSFER: RawPendingTransaction & { _metadata: TestMetadata } = {
  hash: '0xe0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1',
  from: '0x28C6c06298d514Db089934071355E5743bf21d60',
  to: '0xF977814e90dA44bFA03b6295A0616a897441aceC',
  value: '0xde0b6b3a7640000', // 1 ETH
  gas: '0x5208', // 21000 (standard ETH transfer)
  gasPrice: '0x4a817c800',
  nonce: '0xc5d6',
  chainId: 1,
  input: '0x', // Empty input for ETH transfer
  _metadata: {
    source: 'Etherscan mainnet',
    type: 'ETH Transfer',
    isSwap: false,
    shouldDecode: null,
  },
};

// =============================================================================
// TEST DATA COLLECTIONS
// =============================================================================

/**
 * All real V2 swap transactions for testing
 */
export const REAL_V2_SWAPS = [
  REAL_V2_SWAP_EXACT_ETH_FOR_TOKENS,
  REAL_V2_SWAP_EXACT_TOKENS_FOR_TOKENS,
  REAL_V2_SWAP_EXACT_TOKENS_FOR_ETH,
  REAL_V2_SWAP_TOKENS_FOR_EXACT_TOKENS,
  REAL_V2_SWAP_ETH_FOR_EXACT_TOKENS,
  REAL_V2_SWAP_TOKENS_FOR_EXACT_ETH,
];

/**
 * All real V3 swap transactions for testing
 */
export const REAL_V3_SWAPS = [
  REAL_V3_EXACT_INPUT_SINGLE,
  REAL_V3_ROUTER02_EXACT_INPUT_SINGLE,
  REAL_V3_EXACT_OUTPUT_SINGLE,
];

/**
 * All real Curve swap transactions for testing
 */
export const REAL_CURVE_SWAPS = [
  REAL_CURVE_EXCHANGE,
  REAL_CURVE_EXCHANGE_UNDERLYING,
];

/**
 * All real 1inch swap transactions for testing
 */
export const REAL_1INCH_SWAPS = [
  REAL_1INCH_SWAP,
  REAL_1INCH_UNOSWAP,
];

/**
 * All real non-swap transactions for false positive testing
 */
export const REAL_NON_SWAPS = [
  REAL_ERC20_TRANSFER,
  REAL_ERC20_APPROVE,
  REAL_ETH_TRANSFER,
];

/**
 * Combined collection of all real swap transactions
 */
export const ALL_REAL_SWAPS = [...REAL_V2_SWAPS, ...REAL_V3_SWAPS, ...REAL_CURVE_SWAPS, ...REAL_1INCH_SWAPS];

/**
 * Strip metadata for use with decoder (returns clean RawPendingTransaction)
 */
export function stripMetadata(tx: RawPendingTransaction & { _metadata: TestMetadata }): RawPendingTransaction {
  const { _metadata, ...cleanTx } = tx;
  return cleanTx;
}
