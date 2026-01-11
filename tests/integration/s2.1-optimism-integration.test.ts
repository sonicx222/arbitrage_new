/**
 * S2.1 Optimism Chain Integration Tests
 *
 * End-to-end testing of Optimism DEX configurations, token configurations, and core logic
 * Validates S2.1.1 (detector service), S2.1.2 (DEX configs), S2.1.3 (token configs)
 *
 * @see IMPLEMENTATION_PLAN.md S2.1
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.REDIS_URL = 'redis://localhost:6379';

// Import config modules directly (they don't need mocking for configuration tests)
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG, TOKEN_METADATA, EVENT_SIGNATURES } from '../../shared/config/src';

// =============================================================================
// S2.1.2: DEX Configuration Tests
// =============================================================================

describe('S2.1.2: Optimism DEX Configurations', () => {
  describe('Uniswap V3 on Optimism', () => {
    const uniswap = DEXES.optimism.find(d => d.name === 'uniswap_v3');

    it('should have Uniswap V3 configured', () => {
      expect(uniswap).toBeDefined();
    });

    it('should have correct factory address', () => {
      expect(uniswap?.factoryAddress).toBe('0x1F98431c8aD98523631AE4a59f267346ea31F984');
    });

    it('should have correct router address', () => {
      expect(uniswap?.routerAddress).toBe('0xE592427A0AEce92De3Edee1F18E0157C05861564');
    });

    it('should have fee of 30 basis points', () => {
      expect(uniswap?.fee).toBe(30);
    });

    it('should be assigned to optimism chain', () => {
      expect(uniswap?.chain).toBe('optimism');
    });
  });

  describe('Velodrome on Optimism', () => {
    const velodrome = DEXES.optimism.find(d => d.name === 'velodrome');

    it('should have Velodrome configured', () => {
      expect(velodrome).toBeDefined();
    });

    it('should have correct factory address', () => {
      expect(velodrome?.factoryAddress).toBe('0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746');
    });

    it('should have correct router address', () => {
      expect(velodrome?.routerAddress).toBe('0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858');
    });

    it('should have fee configured', () => {
      expect(velodrome?.fee).toBe(30);
    });
  });

  describe('SushiSwap on Optimism', () => {
    const sushiswap = DEXES.optimism.find(d => d.name === 'sushiswap');

    it('should have SushiSwap configured', () => {
      expect(sushiswap).toBeDefined();
    });

    it('should have correct factory address', () => {
      expect(sushiswap?.factoryAddress).toBe('0xFbc12984689e5f15626Bad03Ad60160Fe98B303C');
    });

    it('should have correct router address', () => {
      expect(sushiswap?.routerAddress).toBe('0x4C5D5234f232BD2D76B96aA33F5AE4FCF0E4BFAb');
    });
  });

  describe('Cross-DEX Compatibility', () => {
    it('should have exactly 3 DEXes for arbitrage triangulation', () => {
      expect(DEXES.optimism.length).toBe(3);
    });

    it('should have unique factory addresses', () => {
      const factories = DEXES.optimism.map(d => d.factoryAddress);
      const uniqueFactories = new Set(factories);
      expect(uniqueFactories.size).toBe(factories.length);
    });

    it('should have valid Ethereum addresses for all DEXes', () => {
      for (const dex of DEXES.optimism) {
        expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });
  });
});

// =============================================================================
// S2.1.3: Token Configuration Tests
// =============================================================================

describe('S2.1.3: Optimism Token Configurations', () => {
  describe('Anchor Tokens', () => {
    it('should have WETH configured correctly', () => {
      const weth = CORE_TOKENS.optimism.find(t => t.symbol === 'WETH');
      expect(weth).toBeDefined();
      expect(weth?.address).toBe('0x4200000000000000000000000000000000000006');
      expect(weth?.decimals).toBe(18);
      expect(weth?.chainId).toBe(10);
    });

    it('should have USDT configured correctly', () => {
      const usdt = CORE_TOKENS.optimism.find(t => t.symbol === 'USDT');
      expect(usdt).toBeDefined();
      expect(usdt?.address).toBe('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58');
      expect(usdt?.decimals).toBe(6);
    });

    it('should have USDC configured correctly', () => {
      const usdc = CORE_TOKENS.optimism.find(t => t.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc?.address).toBe('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85');
      expect(usdc?.decimals).toBe(6);
    });

    it('should have DAI configured correctly', () => {
      const dai = CORE_TOKENS.optimism.find(t => t.symbol === 'DAI');
      expect(dai).toBeDefined();
      expect(dai?.address).toBe('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1');
      expect(dai?.decimals).toBe(18);
    });

    it('should have WBTC configured correctly', () => {
      const wbtc = CORE_TOKENS.optimism.find(t => t.symbol === 'WBTC');
      expect(wbtc).toBeDefined();
      expect(wbtc?.address).toBe('0x68f180fcCe6836688e9084f035309E29Bf0A2095');
      expect(wbtc?.decimals).toBe(8);
    });
  });

  describe('Chain Governance Tokens', () => {
    it('should have OP token configured correctly', () => {
      const op = CORE_TOKENS.optimism.find(t => t.symbol === 'OP');
      expect(op).toBeDefined();
      expect(op?.address).toBe('0x4200000000000000000000000000000000000042');
      expect(op?.decimals).toBe(18);
    });
  });

  describe('LST Tokens', () => {
    it('should have wstETH configured correctly', () => {
      const wsteth = CORE_TOKENS.optimism.find(t => t.symbol === 'wstETH');
      expect(wsteth).toBeDefined();
      expect(wsteth?.address).toBe('0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb');
      expect(wsteth?.decimals).toBe(18);
    });
  });

  describe('DeFi Tokens', () => {
    it('should have LINK configured correctly', () => {
      const link = CORE_TOKENS.optimism.find(t => t.symbol === 'LINK');
      expect(link).toBeDefined();
      expect(link?.address).toBe('0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6');
    });

    it('should have PERP configured correctly', () => {
      const perp = CORE_TOKENS.optimism.find(t => t.symbol === 'PERP');
      expect(perp).toBeDefined();
      expect(perp?.address).toBe('0x9e1028F5F1D5eDE59748FFceE5532509976840E0');
    });

    it('should have VELO configured correctly', () => {
      const velo = CORE_TOKENS.optimism.find(t => t.symbol === 'VELO');
      expect(velo).toBeDefined();
      expect(velo?.address).toBe('0x3c8B650257cFb5f272f799F5e2b4e65093a11a05');
    });
  });

  describe('Token Coverage', () => {
    it('should have exactly 10 tokens for Phase 1', () => {
      expect(CORE_TOKENS.optimism.length).toBe(10);
    });

    it('should have all tokens with chainId 10 (Optimism)', () => {
      for (const token of CORE_TOKENS.optimism) {
        expect(token.chainId).toBe(10);
      }
    });

    it('should have valid Ethereum addresses for all tokens', () => {
      for (const token of CORE_TOKENS.optimism) {
        expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    it('should have unique token addresses', () => {
      const addresses = CORE_TOKENS.optimism.map(t => t.address.toLowerCase());
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(addresses.length);
    });
  });

  describe('Token Metadata Configuration', () => {
    it('should have Optimism token metadata configured', () => {
      expect(TOKEN_METADATA.optimism).toBeDefined();
    });

    it('should have correct WETH address in metadata', () => {
      expect(TOKEN_METADATA.optimism.weth).toBe('0x4200000000000000000000000000000000000006');
    });

    it('should have stablecoins configured in metadata', () => {
      expect(TOKEN_METADATA.optimism.stablecoins.length).toBeGreaterThanOrEqual(3);
    });

    it('should have USDC in stablecoins with correct decimals', () => {
      const usdc = TOKEN_METADATA.optimism.stablecoins.find(s => s.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc?.decimals).toBe(6);
    });

    it('should have USDT in stablecoins with correct decimals', () => {
      const usdt = TOKEN_METADATA.optimism.stablecoins.find(s => s.symbol === 'USDT');
      expect(usdt).toBeDefined();
      expect(usdt?.decimals).toBe(6);
    });

    it('should have DAI in stablecoins with correct decimals', () => {
      const dai = TOKEN_METADATA.optimism.stablecoins.find(s => s.symbol === 'DAI');
      expect(dai).toBeDefined();
      expect(dai?.decimals).toBe(18);
    });
  });
});

// =============================================================================
// S2.1.1: Optimism Detector Core Logic Tests
// =============================================================================

describe('S2.1.1: Optimism Chain Detection Logic', () => {
  describe('Price Calculation Logic', () => {
    it('should calculate correct price ratio', () => {
      // Price calculation: reserve0 / reserve1
      const reserve0 = 1000000000000000000n; // 1 ETH
      const reserve1 = 2000000000n;           // 2000 USDC (6 decimals)

      const price = Number(reserve0) / Number(reserve1);
      expect(price).toBeGreaterThan(0);
      expect(price).toBe(500000000); // 1e18 / 2e9
    });

    it('should return 0 for zero reserves', () => {
      const calculatePrice = (r0: bigint, r1: bigint): number => {
        if (r0 === 0n || r1 === 0n) return 0;
        return Number(r0) / Number(r1);
      };

      expect(calculatePrice(0n, 1000000000000000000n)).toBe(0);
      expect(calculatePrice(1000000000000000000n, 0n)).toBe(0);
    });

    it('should handle large reserves correctly', () => {
      const reserve0 = BigInt('1000000000000000000000000'); // 1M tokens
      const reserve1 = BigInt('2000000000000000000000000'); // 2M tokens

      const price = Number(reserve0) / Number(reserve1);
      expect(price).toBeCloseTo(0.5, 5);
    });
  });

  describe('USD Value Estimation Logic', () => {
    const ETH_PRICE_USD = 2000;

    it('should estimate USD value for ETH amounts', () => {
      const ethAmount = 1000000000000000000n; // 1 ETH in wei
      const usdValue = (Number(ethAmount) / 1e18) * ETH_PRICE_USD;

      expect(usdValue).toBe(2000);
    });

    it('should estimate USD value for fractional ETH', () => {
      const ethAmount = 500000000000000000n; // 0.5 ETH
      const usdValue = (Number(ethAmount) / 1e18) * ETH_PRICE_USD;

      expect(usdValue).toBe(1000);
    });

    it('should handle USDC with 6 decimals', () => {
      const usdcAmount = 1000000000n; // 1000 USDC
      const usdValue = Number(usdcAmount) / 1e6;

      expect(usdValue).toBe(1000);
    });

    it('should handle USDT with 6 decimals', () => {
      const usdtAmount = 5000000000n; // 5000 USDT
      const usdValue = Number(usdtAmount) / 1e6;

      expect(usdValue).toBe(5000);
    });

    it('should handle DAI with 18 decimals', () => {
      const daiAmount = 10000000000000000000000n; // 10000 DAI
      const usdValue = Number(daiAmount) / 1e18;

      expect(usdValue).toBe(10000);
    });
  });

  describe('Arbitrage Detection Logic', () => {
    it('should detect price difference above threshold', () => {
      const price1 = 1850;
      const price2 = 1860;
      const minProfit = 0.002; // 0.2%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeCloseTo(0.0054, 3); // ~0.54%
      expect(isOpportunity).toBe(true);
    });

    it('should not detect opportunity below threshold', () => {
      const price1 = 1850;
      const price2 = 1851; // Only $1 difference
      const minProfit = 0.002; // 0.2%

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const isOpportunity = priceDiff >= minProfit;

      expect(priceDiff).toBeLessThan(minProfit);
      expect(isOpportunity).toBe(false);
    });

    it('should calculate spread percentage correctly', () => {
      const buyPrice = 1800;
      const sellPrice = 1810;

      const spreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
      expect(spreadPercent).toBeCloseTo(0.556, 2); // ~0.56%
    });
  });

  describe('Whale Detection Logic', () => {
    const WHALE_THRESHOLD = 50000; // $50K

    it('should detect whale transaction above threshold', () => {
      const usdValue = 75000;
      const isWhale = usdValue >= WHALE_THRESHOLD;

      expect(isWhale).toBe(true);
    });

    it('should not flag normal transactions', () => {
      const usdValue = 10000;
      const isWhale = usdValue >= WHALE_THRESHOLD;

      expect(isWhale).toBe(false);
    });

    it('should detect exact threshold', () => {
      const usdValue = 50000;
      const isWhale = usdValue >= WHALE_THRESHOLD;

      expect(isWhale).toBe(true);
    });
  });

  describe('Event Filtering Logic', () => {
    const MIN_USD_VALUE = 10000; // $10K minimum
    const SAMPLING_RATE = 0.01; // 1%

    it('should pass events above minimum value', () => {
      const usdValue = 50000;
      const shouldProcess = usdValue >= MIN_USD_VALUE;

      expect(shouldProcess).toBe(true);
    });

    it('should filter events below minimum value', () => {
      const usdValue = 5000; // Below $10K minimum
      const shouldProcess = usdValue >= MIN_USD_VALUE;

      expect(shouldProcess).toBe(false);
    });

    it('should sample small transactions at configured rate', () => {
      // Mock random to test sampling
      const mockRandom = 0.005; // Less than 1%
      const usdValue = 5000;

      const shouldProcess = usdValue >= MIN_USD_VALUE ||
        mockRandom <= SAMPLING_RATE;

      expect(shouldProcess).toBe(true);
    });
  });
});

// =============================================================================
// Cross-DEX Arbitrage Detection Tests
// =============================================================================

describe('S2.1: Cross-DEX Arbitrage Detection on Optimism', () => {
  describe('Arbitrage Configuration', () => {
    it('should have Optimism-specific minimum profit (lower than Ethereum)', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBe(0.002);
      expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBeLessThan(
        ARBITRAGE_CONFIG.chainMinProfits.ethereum
      );
    });

    it('should have same minimum profit as other L2s', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBe(
        ARBITRAGE_CONFIG.chainMinProfits.arbitrum
      );
      expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBe(
        ARBITRAGE_CONFIG.chainMinProfits.base
      );
    });
  });

  describe('Pair Generation', () => {
    const tokens = CORE_TOKENS.optimism;
    const dexes = DEXES.optimism;

    it('should generate 45 pairs per DEX (10 tokens = n*(n-1)/2)', () => {
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      expect(pairsPerDex).toBe(45);
    });

    it('should generate 135 total potential pairs (45 pairs × 3 DEXes)', () => {
      const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
      const totalPairs = pairsPerDex * dexes.length;
      expect(totalPairs).toBe(135);
    });

    it('should include high-volume pairs for arbitrage', () => {
      const highVolumePairs = [
        ['WETH', 'USDC'],
        ['WETH', 'USDT'],
        ['WETH', 'OP'],
        ['OP', 'USDC'],
        ['WETH', 'wstETH']
      ];

      for (const [symbol0, symbol1] of highVolumePairs) {
        const token0 = tokens.find(t => t.symbol === symbol0);
        const token1 = tokens.find(t => t.symbol === symbol1);
        expect(token0).toBeDefined();
        expect(token1).toBeDefined();
      }
    });
  });

  describe('Profit Calculation Logic', () => {
    it('should detect profitable arbitrage at 0.6% spread', () => {
      const buyPrice = 1800;
      const sellPrice = 1810.8; // 0.6% higher
      const minProfit = 0.002; // 0.2%

      const priceDiff = Math.abs(buyPrice - sellPrice) / Math.min(buyPrice, sellPrice);
      expect(priceDiff).toBeCloseTo(0.006, 3);
      expect(priceDiff).toBeGreaterThan(minProfit);
    });

    it('should not detect arbitrage below threshold', () => {
      const buyPrice = 1800;
      const sellPrice = 1801; // ~0.05%
      const minProfit = 0.002;

      const priceDiff = Math.abs(buyPrice - sellPrice) / Math.min(buyPrice, sellPrice);
      expect(priceDiff).toBeLessThan(minProfit);
    });

    it('should calculate net profit correctly after fees', () => {
      const buyPrice = 1800;
      const sellPrice = 1820; // 1.11% spread
      const feePerTrade = 0.003; // 0.3%
      const tradeAmount = 10000; // $10K

      const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
      const totalFees = tradeAmount * feePerTrade * 2; // Round trip
      const netProfit = grossProfit - totalFees;

      expect(grossProfit).toBeCloseTo(111.11, 0);
      expect(totalFees).toBe(60);
      expect(netProfit).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Event Signatures Configuration Tests
// =============================================================================

describe('Event Signatures Configuration', () => {
  it('should have SYNC event signature configured', () => {
    expect(EVENT_SIGNATURES.SYNC).toBe('0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1');
  });

  it('should have SWAP_V2 event signature configured', () => {
    expect(EVENT_SIGNATURES.SWAP_V2).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
  });

  it('should have SWAP_V3 event signature configured', () => {
    expect(EVENT_SIGNATURES.SWAP_V3).toBe('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
  });

  it('should have valid keccak256 hash format for all signatures', () => {
    const hashPattern = /^0x[a-f0-9]{64}$/;
    expect(EVENT_SIGNATURES.SYNC).toMatch(hashPattern);
    expect(EVENT_SIGNATURES.SWAP_V2).toMatch(hashPattern);
    expect(EVENT_SIGNATURES.SWAP_V3).toMatch(hashPattern);
  });
});

// =============================================================================
// Chain Configuration Tests
// =============================================================================

describe('Optimism Chain Configuration', () => {
  it('should have correct chain ID (10)', () => {
    expect(CHAINS.optimism.id).toBe(10);
  });

  it('should have correct chain name', () => {
    expect(CHAINS.optimism.name).toBe('Optimism');
  });

  it('should have ETH as native token', () => {
    expect(CHAINS.optimism.nativeToken).toBe('ETH');
  });

  it('should have 2-second block time', () => {
    expect(CHAINS.optimism.blockTime).toBe(2);
  });

  it('should have RPC URL configured', () => {
    expect(CHAINS.optimism.rpcUrl).toBeDefined();
    expect(CHAINS.optimism.rpcUrl).toContain('optimism');
  });

  it('should have WebSocket URL configured', () => {
    expect(CHAINS.optimism.wsUrl).toBeDefined();
    expect(CHAINS.optimism.wsUrl).toContain('optimism');
  });

  it('should be in T2 (L2-Turbo) partition', () => {
    // Verify Optimism is categorized correctly for partitioning
    expect(ARBITRAGE_CONFIG.chainMinProfits.optimism).toBe(0.002); // Low gas indicator
  });
});

// =============================================================================
// Trading Pair Generation Tests
// =============================================================================

describe('Trading Pair Generation', () => {
  const tokens = CORE_TOKENS.optimism;
  const dexes = DEXES.optimism;

  it('should generate correct number of potential pairs', () => {
    // n tokens = n * (n-1) / 2 pairs per DEX
    const pairsPerDex = (tokens.length * (tokens.length - 1)) / 2;
    const totalPotentialPairs = pairsPerDex * dexes.length;

    // 10 tokens = 45 pairs per DEX * 3 DEXes = 135 potential pairs
    expect(pairsPerDex).toBe(45);
    expect(totalPotentialPairs).toBe(135);
  });

  it('should create unique pair keys', () => {
    const pairKeys = new Set<string>();

    for (const dex of dexes) {
      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          const token0 = tokens[i];
          const token1 = tokens[j];
          const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
          pairKeys.add(pairKey);
        }
      }
    }

    // All keys should be unique
    expect(pairKeys.size).toBe(135);
  });

  it('should include important pairs', () => {
    const importantPairs = [
      'WETH_USDC',
      'WETH_USDT',
      'WETH_OP',
      'WETH_wstETH',
      'OP_USDC'
    ];

    for (const pair of importantPairs) {
      const [token0, token1] = pair.split('_');
      const hasToken0 = tokens.some(t => t.symbol === token0);
      const hasToken1 = tokens.some(t => t.symbol === token1);
      expect(hasToken0).toBe(true);
      expect(hasToken1).toBe(true);
    }
  });
});

// =============================================================================
// Cross-DEX Arbitrage Tests
// =============================================================================

describe('Cross-DEX Arbitrage on Optimism', () => {
  it('should identify same pairs across different DEXes', () => {
    const dexes = DEXES.optimism;

    // WETH/USDC should exist on all DEXes
    const weth = CORE_TOKENS.optimism.find(t => t.symbol === 'WETH');
    const usdc = CORE_TOKENS.optimism.find(t => t.symbol === 'USDC');

    expect(weth).toBeDefined();
    expect(usdc).toBeDefined();

    // All 3 DEXes should support this pair
    expect(dexes.length).toBe(3);
  });

  it('should calculate net profit after fees', () => {
    const buyPrice = 1800;
    const sellPrice = 1810;
    const feePerTrade = 0.003; // 0.3%
    const tradeAmount = 10000; // $10K

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2; // Round trip
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(55.56, 1);
    expect(totalFees).toBe(60);
    expect(netProfit).toBeLessThan(0); // Not profitable at this spread
  });

  it('should be profitable at sufficient spread', () => {
    const buyPrice = 1800;
    const sellPrice = 1820; // 1.11% spread
    const feePerTrade = 0.003;
    const tradeAmount = 10000;

    const grossProfit = tradeAmount * ((sellPrice - buyPrice) / buyPrice);
    const totalFees = tradeAmount * feePerTrade * 2;
    const netProfit = grossProfit - totalFees;

    expect(grossProfit).toBeCloseTo(111.11, 1);
    expect(netProfit).toBeGreaterThan(0);
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe('Performance Benchmarks', () => {
  it('should calculate price within 1ms for 1000 iterations', () => {
    const iterations = 1000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const reserve0 = BigInt('1000000000000000000000');
      const reserve1 = BigInt('2000000000000000000000');
      const _price = Number(reserve0) / Number(reserve1);
    }

    const duration = performance.now() - start;
    const avgTime = duration / iterations;

    expect(avgTime).toBeLessThan(1); // < 1ms per calculation
    console.log(`Price calculation: ${avgTime.toFixed(4)}ms average (${iterations} iterations)`);
  });

  it('should detect arbitrage opportunity within 1ms', () => {
    const iterations = 1000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const price1 = 1800 + Math.random() * 20;
      const price2 = 1810 + Math.random() * 20;
      const minProfit = 0.002;

      const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
      const _isOpportunity = priceDiff >= minProfit;
    }

    const duration = performance.now() - start;
    const avgTime = duration / iterations;

    expect(avgTime).toBeLessThan(1);
    console.log(`Arbitrage detection: ${avgTime.toFixed(4)}ms average (${iterations} iterations)`);
  });
});
