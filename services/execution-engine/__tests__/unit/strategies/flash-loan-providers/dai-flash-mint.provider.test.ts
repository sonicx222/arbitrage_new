/**
 * Unit Tests for DaiFlashMintProvider
 *
 * Uses the shared flash-loan-provider harness for common tests,
 * plus DAI-specific tests for asset restriction, chain validation,
 * EIP-3156 calldata structure, and DssFlash-specific behavior.
 *
 * @see dai-flash-mint.provider.ts
 * @see contracts/src/DaiFlashMintArbitrage.sol
 */

import { ethers } from 'ethers';
import { DaiFlashMintProvider } from '../../../../src/strategies/flash-loan-providers/dai-flash-mint.provider';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
} from '../../../../src/strategies/flash-loan-providers/types';
import {
  testFlashLoanProvider,
  FLASH_LOAN_TEST_ADDRESSES,
} from '@arbitrage/test-utils/harnesses/flash-loan-provider.harness';

// Mock @arbitrage/config — must be inline literal (hoisted above const)
jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  getBpsDenominatorBigInt: () => BigInt(10000),
  ARBITRAGE_CONFIG: {
    gasPriceSpikeMultiplier: 2,
    maxGasPrice: '500',
    minProfitThreshold: '0.001',
    maxTradeSize: '10',
    defaultSlippageBps: 50,
    slippageTolerance: 0.05,
  },
}));

jest.mock('../../../../src/strategies/base.strategy', () => ({
  getSwapDeadline: () => Math.floor(Date.now() / 1000) + 300,
}));

// =============================================================================
// DAI Flash Mint Config
// =============================================================================

const DSS_FLASH = '0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853';
const DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

const createConfig = (overrides?: Record<string, any>) => ({
  chain: 'ethereum',
  poolAddress: DSS_FLASH,
  contractAddress: FLASH_LOAN_TEST_ADDRESSES.CONTRACT,
  approvedRouters: [FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, FLASH_LOAN_TEST_ADDRESSES.ROUTER_SUSHISWAP],
  ...overrides,
});

/** DAI-specific request factory — asset must always be DAI */
const createDaiRequest = (overrides?: Partial<FlashLoanRequest>): FlashLoanRequest => ({
  asset: DAI_ADDRESS,
  amount: ethers.parseEther('10000'),
  chain: 'ethereum',
  swapPath: [
    {
      router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: DAI_ADDRESS,
      tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH,
      amountOutMin: ethers.parseEther('4.95'),
    },
    {
      router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH,
      tokenOut: DAI_ADDRESS,
      amountOutMin: ethers.parseEther('9950'),
    },
  ] as FlashLoanSwapStep[],
  minProfit: ethers.parseEther('10'),
  initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
  ...overrides,
});

// =============================================================================
// Shared Tests (constructor, fee, validation, calldata, gas, integration)
// =============================================================================

testFlashLoanProvider({
  name: 'DaiFlashMintProvider',
  protocol: 'dai_flash_mint',
  ProviderClass: DaiFlashMintProvider,
  defaultFeeBps: 1,
  defaultGasEstimate: 450000n,
  poolAddress: DSS_FLASH,
  createConfig,
  createRequest: createDaiRequest,
  // DAI-specific overrides:
  expectedTxTarget: DSS_FLASH,              // tx goes to DssFlash, not contract
  skipCalldataDecodeTest: true,             // uses EIP-3156 flashLoan ABI, not executeArbitrage
  wrongChainErrorCode: '[ERR_CHAIN_NOT_SUPPORTED]',  // DAI has custom chain validation
  invalidAssetErrorCode: '[ERR_ASSET_NOT_DAI]',      // DAI rejects non-DAI before standard validation
});

// =============================================================================
// DAI-Specific: Asset Restriction
// =============================================================================

describe('DaiFlashMintProvider — DAI-only asset restriction', () => {
  it('should reject WETH as asset', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const result = provider.validate(createDaiRequest({ asset: FLASH_LOAN_TEST_ADDRESSES.WETH }));

    expect(result.valid).toBe(false);
    expect(result.error).toContain('[ERR_ASSET_NOT_DAI]');
    expect(result.error).toContain(DAI_ADDRESS);
  });

  it('should reject USDC as asset', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const result = provider.validate(createDaiRequest({ asset: FLASH_LOAN_TEST_ADDRESSES.USDC }));

    expect(result.valid).toBe(false);
    expect(result.error).toContain('[ERR_ASSET_NOT_DAI]');
  });

  it('should include DAI in capabilities supportedTokens', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const capabilities = provider.getCapabilities();

    expect(capabilities.supportedTokens).toHaveLength(1);
    expect(capabilities.supportedTokens[0]).toBe(DAI_ADDRESS);
  });
});

// =============================================================================
// DAI-Specific: Chain Restriction (Ethereum-only)
// =============================================================================

describe('DaiFlashMintProvider — Ethereum-only chain restriction', () => {
  it.each(['arbitrum', 'bsc', 'polygon', 'base', 'optimism'])('should reject %s chain', (chain) => {
    const provider = new DaiFlashMintProvider(createConfig({ chain }));
    expect(provider.isAvailable()).toBe(false);
  });

  it('should be available only on ethereum', () => {
    const ethProvider = new DaiFlashMintProvider(createConfig({ chain: 'ethereum' }));
    expect(ethProvider.isAvailable()).toBe(true);
  });

  it('should reject non-ethereum in validation', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const result = provider.validate(createDaiRequest({ chain: 'arbitrum' }));

    expect(result.valid).toBe(false);
    expect(result.error).toContain('[ERR_CHAIN_NOT_SUPPORTED]');
    expect(result.error).toContain('arbitrum');
  });
});

// =============================================================================
// DAI-Specific: EIP-3156 Calldata Structure
// =============================================================================

describe('DaiFlashMintProvider — EIP-3156 calldata', () => {
  const EIP3156_IFACE = new ethers.Interface([
    'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool)',
  ]);

  it('should encode using EIP-3156 flashLoan selector', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const calldata = provider.buildCalldata(createDaiRequest());

    const expectedSelector = EIP3156_IFACE.getFunction('flashLoan')!.selector;
    expect(calldata.substring(0, 10)).toBe(expectedSelector);
  });

  it('should encode receiver as the contract address', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const calldata = provider.buildCalldata(createDaiRequest());
    const decoded = EIP3156_IFACE.decodeFunctionData('flashLoan', calldata);

    expect(decoded[0]).toBe(FLASH_LOAN_TEST_ADDRESSES.CONTRACT);
  });

  it('should encode DAI as the token', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const calldata = provider.buildCalldata(createDaiRequest());
    const decoded = EIP3156_IFACE.decodeFunctionData('flashLoan', calldata);

    expect(decoded[1]).toBe(DAI_ADDRESS);
  });

  it('should encode the correct amount', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const request = createDaiRequest();
    const calldata = provider.buildCalldata(request);
    const decoded = EIP3156_IFACE.decodeFunctionData('flashLoan', calldata);

    expect(decoded[2]).toBe(request.amount);
  });

  it('should encode inner data with swap path, minProfit, and deadline', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const request = createDaiRequest();
    const calldata = provider.buildCalldata(request);
    const decoded = EIP3156_IFACE.decodeFunctionData('flashLoan', calldata);

    const innerData = decoded[3];
    const innerDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(address,address,address,uint256)[]', 'uint256', 'uint256'],
      innerData
    );

    expect(innerDecoded[0].length).toBe(2);
    expect(innerDecoded[0][0][0]).toBe(FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP);
    expect(innerDecoded[0][0][1]).toBe(DAI_ADDRESS);
    expect(innerDecoded[1]).toBe(request.minProfit);
    expect(Number(innerDecoded[2])).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

// =============================================================================
// DAI-Specific: DssFlash getter
// =============================================================================

describe('DaiFlashMintProvider — DssFlash getter', () => {
  it('should return DssFlash address matching poolAddress', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    expect(provider.getDssFlashAddress()).toBe(DSS_FLASH);
    expect(provider.getDssFlashAddress()).toBe(provider.poolAddress);
  });
});

// =============================================================================
// DAI-Specific: Fee precision (1 bps)
// =============================================================================

describe('DaiFlashMintProvider — fee precision (1 bps)', () => {
  it('should calculate 1 DAI fee on 10000 DAI', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const feeInfo = provider.calculateFee(ethers.parseEther('10000'));

    expect(feeInfo.feeBps).toBe(1);
    expect(feeInfo.feeAmount).toBe(ethers.parseEther('1'));
  });

  it('should have the lowest fee of pool-based providers (1 bps)', () => {
    const provider = new DaiFlashMintProvider(createConfig());
    const feeInfo = provider.calculateFee(ethers.parseEther('100000'));

    expect(feeInfo.feeBps).toBe(1);
    expect(feeInfo.feeAmount).toBe(ethers.parseEther('10'));
  });
});
