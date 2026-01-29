/**
 * Tests for Zod Schema Validation
 *
 * @see schemas/index.ts
 */

import {
  EthereumAddressSchema,
  SolanaAddressSchema,
  ChainSchema,
  DexSchema,
  FactoryConfigSchema,
  TokenSchema,
  FlashLoanProviderSchema,
  BridgeCostConfigSchema,
  BasisPointsSchema,
  validateWithDetails,
  validateOrThrow,
  createValidator,
} from '../../schemas';

describe('Primitive Schemas', () => {
  describe('EthereumAddressSchema', () => {
    it('should accept valid checksummed address', () => {
      const result = EthereumAddressSchema.safeParse(
        '0x1F98431c8aD98523631AE4a59f267346ea31F984'
      );
      expect(result.success).toBe(true);
    });

    it('should accept valid lowercase address', () => {
      const result = EthereumAddressSchema.safeParse(
        '0x1f98431c8ad98523631ae4a59f267346ea31f984'
      );
      expect(result.success).toBe(true);
    });

    it('should reject address without 0x prefix', () => {
      const result = EthereumAddressSchema.safeParse(
        '1F98431c8aD98523631AE4a59f267346ea31F984'
      );
      expect(result.success).toBe(false);
    });

    it('should reject address with wrong length', () => {
      const result = EthereumAddressSchema.safeParse('0x1F98431c8aD');
      expect(result.success).toBe(false);
    });

    it('should reject address with invalid characters', () => {
      const result = EthereumAddressSchema.safeParse(
        '0xGGGG431c8aD98523631AE4a59f267346ea31F984'
      );
      expect(result.success).toBe(false);
    });
  });

  describe('SolanaAddressSchema', () => {
    it('should accept valid Solana address', () => {
      const result = SolanaAddressSchema.safeParse(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC mint
      );
      expect(result.success).toBe(true);
    });

    it('should accept valid program ID', () => {
      const result = SolanaAddressSchema.safeParse(
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
      );
      expect(result.success).toBe(true);
    });

    it('should reject address with invalid characters (0, O, I, l)', () => {
      // Base58 excludes 0, O, I, l to avoid ambiguity
      const result = SolanaAddressSchema.safeParse(
        '0PjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      );
      expect(result.success).toBe(false);
    });

    it('should reject address too short', () => {
      const result = SolanaAddressSchema.safeParse('EPjFWdd5Aufq');
      expect(result.success).toBe(false);
    });
  });

  describe('BasisPointsSchema', () => {
    it('should accept 0 (0%)', () => {
      expect(BasisPointsSchema.safeParse(0).success).toBe(true);
    });

    it('should accept 30 (0.30%)', () => {
      expect(BasisPointsSchema.safeParse(30).success).toBe(true);
    });

    it('should accept 10000 (100%)', () => {
      expect(BasisPointsSchema.safeParse(10000).success).toBe(true);
    });

    it('should reject negative values', () => {
      expect(BasisPointsSchema.safeParse(-1).success).toBe(false);
    });

    it('should reject values over 10000', () => {
      expect(BasisPointsSchema.safeParse(10001).success).toBe(false);
    });

    it('should reject non-integers', () => {
      expect(BasisPointsSchema.safeParse(30.5).success).toBe(false);
    });
  });
});

describe('ChainSchema', () => {
  const validChain = {
    id: 1,
    name: 'Ethereum',
    rpcUrl: 'https://eth.llamarpc.com',
    wsUrl: 'wss://eth.llamarpc.com',
    blockTime: 12,
    nativeToken: 'ETH',
  };

  it('should accept valid chain config', () => {
    const result = ChainSchema.safeParse(validChain);
    expect(result.success).toBe(true);
  });

  it('should accept chain without optional fields', () => {
    const { wsUrl, ...minimalChain } = validChain;
    const result = ChainSchema.safeParse(minimalChain);
    expect(result.success).toBe(true);
  });

  it('should accept chain with fallback URLs', () => {
    const result = ChainSchema.safeParse({
      ...validChain,
      wsFallbackUrls: ['wss://fallback1.com', 'wss://fallback2.com'],
      rpcFallbackUrls: ['https://fallback1.com', 'https://fallback2.com'],
    });
    expect(result.success).toBe(true);
  });

  it('should default isEVM to true', () => {
    const result = ChainSchema.safeParse(validChain);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isEVM).toBe(true);
    }
  });

  it('should reject invalid RPC URL', () => {
    const result = ChainSchema.safeParse({
      ...validChain,
      rpcUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid WebSocket URL', () => {
    const result = ChainSchema.safeParse({
      ...validChain,
      wsUrl: 'https://not-ws.com',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-positive chain ID', () => {
    const result = ChainSchema.safeParse({
      ...validChain,
      id: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative block time', () => {
    const result = ChainSchema.safeParse({
      ...validChain,
      blockTime: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('DexSchema', () => {
  const validDex = {
    name: 'uniswap_v3',
    chain: 'ethereum',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    fee: 30,
  };

  it('should accept valid DEX config', () => {
    const result = DexSchema.safeParse(validDex);
    expect(result.success).toBe(true);
  });

  it('should accept DEX with type', () => {
    const result = DexSchema.safeParse({
      ...validDex,
      type: 'clmm',
    });
    expect(result.success).toBe(true);
  });

  it('should default enabled to true', () => {
    const result = DexSchema.safeParse(validDex);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it('should reject invalid factory address', () => {
    const result = DexSchema.safeParse({
      ...validDex,
      factoryAddress: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('should reject fee over 10000 bps', () => {
    const result = DexSchema.safeParse({
      ...validDex,
      fee: 15000,
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid DEX type', () => {
    const result = DexSchema.safeParse({
      ...validDex,
      type: 'invalid_type',
    });
    expect(result.success).toBe(false);
  });
});

describe('FactoryConfigSchema', () => {
  const validFactory = {
    address: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    dexName: 'uniswap_v3',
    type: 'uniswap_v3' as const,
    chain: 'ethereum',
  };

  it('should accept valid factory config', () => {
    const result = FactoryConfigSchema.safeParse(validFactory);
    expect(result.success).toBe(true);
  });

  it('should accept factory with init code hash', () => {
    const result = FactoryConfigSchema.safeParse({
      ...validFactory,
      initCodeHash: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
    });
    expect(result.success).toBe(true);
  });

  it('should default supportsFactoryEvents to true', () => {
    const result = FactoryConfigSchema.safeParse(validFactory);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supportsFactoryEvents).toBe(true);
    }
  });

  it('should reject invalid init code hash format', () => {
    const result = FactoryConfigSchema.safeParse({
      ...validFactory,
      initCodeHash: '0xshort',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid factory type', () => {
    const result = FactoryConfigSchema.safeParse({
      ...validFactory,
      type: 'invalid_type',
    });
    expect(result.success).toBe(false);
  });
});

describe('TokenSchema', () => {
  const validToken = {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol: 'WETH',
    decimals: 18,
    chainId: 1,
  };

  it('should accept valid token config', () => {
    const result = TokenSchema.safeParse(validToken);
    expect(result.success).toBe(true);
  });

  it('should accept token with 0 decimals', () => {
    const result = TokenSchema.safeParse({
      ...validToken,
      decimals: 0,
    });
    expect(result.success).toBe(true);
  });

  it('should reject decimals over 18', () => {
    const result = TokenSchema.safeParse({
      ...validToken,
      decimals: 19,
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty symbol', () => {
    const result = TokenSchema.safeParse({
      ...validToken,
      symbol: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject symbol over 20 chars', () => {
    const result = TokenSchema.safeParse({
      ...validToken,
      symbol: 'VERYLONGSYMBOLNAME123',
    });
    expect(result.success).toBe(false);
  });
});

describe('FlashLoanProviderSchema', () => {
  it('should accept valid Aave provider', () => {
    const result = FlashLoanProviderSchema.safeParse({
      address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
      protocol: 'aave_v3',
      fee: 9,
    });
    expect(result.success).toBe(true);
  });

  it('should accept Jupiter provider with empty address', () => {
    const result = FlashLoanProviderSchema.safeParse({
      address: '',
      protocol: 'jupiter',
      fee: 0,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid protocol', () => {
    const result = FlashLoanProviderSchema.safeParse({
      address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
      protocol: 'unknown_protocol',
      fee: 9,
    });
    expect(result.success).toBe(false);
  });
});

describe('BridgeCostConfigSchema', () => {
  const validBridgeCost = {
    bridge: 'stargate',
    sourceChain: 'ethereum',
    targetChain: 'arbitrum',
    feePercentage: 0.06,
    minFeeUsd: 1,
    estimatedLatencySeconds: 180,
    reliability: 0.95,
  };

  it('should accept valid bridge cost config', () => {
    const result = BridgeCostConfigSchema.safeParse(validBridgeCost);
    expect(result.success).toBe(true);
  });

  it('should reject reliability over 1', () => {
    const result = BridgeCostConfigSchema.safeParse({
      ...validBridgeCost,
      reliability: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative fee percentage', () => {
    const result = BridgeCostConfigSchema.safeParse({
      ...validBridgeCost,
      feePercentage: -0.01,
    });
    expect(result.success).toBe(false);
  });

  it('should reject fee percentage over 100', () => {
    const result = BridgeCostConfigSchema.safeParse({
      ...validBridgeCost,
      feePercentage: 101,
    });
    expect(result.success).toBe(false);
  });
});

describe('Validation Helpers', () => {
  describe('validateWithDetails', () => {
    it('should return success with data for valid input', () => {
      const result = validateWithDetails(BasisPointsSchema, 30);
      expect(result.success).toBe(true);
      expect(result.data).toBe(30);
      expect(result.errors).toBeUndefined();
    });

    it('should return errors for invalid input', () => {
      const result = validateWithDetails(BasisPointsSchema, -1);
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe('validateOrThrow', () => {
    it('should return data for valid input', () => {
      const data = validateOrThrow(BasisPointsSchema, 30, 'test');
      expect(data).toBe(30);
    });

    it('should throw for invalid input', () => {
      expect(() => {
        validateOrThrow(BasisPointsSchema, -1, 'test');
      }).toThrow('Config validation failed for test');
    });
  });

  describe('createValidator', () => {
    it('should create reusable validator function', () => {
      const validateBps = createValidator(BasisPointsSchema, 'BPS');
      expect(validateBps(30)).toBe(30);
      expect(() => validateBps(-1)).toThrow('BPS');
    });
  });
});
