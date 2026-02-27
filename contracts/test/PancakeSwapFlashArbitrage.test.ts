import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import {
  PancakeSwapFlashArbitrage,
  MockPancakeV3Factory,
  MockPancakeV3Pool,
  MockDexRouter,
  MockERC20,
} from '../typechain-types';
import {
  deployBaseFixture,
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  getDeadline,
  testRouterManagement,
  testMinimumProfitConfig,
  testSwapDeadlineConfig,
  testPauseUnpause,
  testWithdrawToken,
  testWithdrawETH,
  testWithdrawGasLimitConfig,
  testOwnable2Step,
  build2HopPath,
  build2HopCrossRouterPath,
  type AdminTestConfig,
} from './helpers';

/**
 * PancakeSwapFlashArbitrage Contract Tests
 *
 * Tests follow TDD approach for Task 2.1 (FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md):
 * - [x] Create PancakeSwap V3 flash loan arbitrage contract
 * - [x] Implement IPancakeV3FlashCallback
 * - [x] Add multi-hop swap execution
 * - [x] Add profit verification and return
 * - [x] Pool whitelist security
 * - [x] Dynamic fee support (100, 500, 2500, 10000 bps)
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 2.1
 */
describe('PancakeSwapFlashArbitrage', () => {
  // Test fixtures for consistent state
  async function deployContractsFixture() {
    const base = await deployBaseFixture();
    const { weth, usdc, dai } = base;

    // Deploy PancakeSwap V3 factory and create pools
    const MockPancakeV3FactoryFactory = await ethers.getContractFactory('MockPancakeV3Factory');
    const pancakeFactory = await MockPancakeV3FactoryFactory.deploy();

    const wethAddress = await weth.getAddress();
    const usdcAddress = await usdc.getAddress();
    const daiAddress = await dai.getAddress();

    // WETH/USDC pool with 0.25% fee (2500 bps - most common)
    await pancakeFactory.createPool(wethAddress, usdcAddress, 2500);
    const wethUsdcPoolAddress = await pancakeFactory.getPool(wethAddress, usdcAddress, 2500);
    const wethUsdcPool = await ethers.getContractAt('MockPancakeV3Pool', wethUsdcPoolAddress);

    // USDC/DAI pool with 0.01% fee (100 bps - stablecoin pair)
    await pancakeFactory.createPool(usdcAddress, daiAddress, 100);
    const usdcDaiPoolAddress = await pancakeFactory.getPool(usdcAddress, daiAddress, 100);
    const usdcDaiPool = await ethers.getContractAt('MockPancakeV3Pool', usdcDaiPoolAddress);

    // Deploy PancakeSwapFlashArbitrage contract
    const PancakeSwapFlashArbitrageFactory = await ethers.getContractFactory(
      'PancakeSwapFlashArbitrage'
    );
    const flashArbitrage = await PancakeSwapFlashArbitrageFactory.deploy(
      await pancakeFactory.getAddress(),
      base.owner.address
    );

    // Fund pools for flash loans
    await weth.mint(wethUsdcPoolAddress, ethers.parseEther('10000'));
    await usdc.mint(wethUsdcPoolAddress, ethers.parseUnits('20000000', 6));
    await usdc.mint(usdcDaiPoolAddress, ethers.parseUnits('5000000', 6));
    await dai.mint(usdcDaiPoolAddress, ethers.parseEther('5000000'));

    return { flashArbitrage, pancakeFactory, wethUsdcPool, usdcDaiPool, ...base };
  }

  // ===========================================================================
  // Deployment Tests
  // ===========================================================================
  describe('Deployment', () => {
    it('should deploy with correct owner', async () => {
      const { flashArbitrage, owner } = await loadFixture(deployContractsFixture);
      expect(await flashArbitrage.owner()).to.equal(owner.address);
    });

    it('should set correct factory address', async () => {
      const { flashArbitrage, pancakeFactory } = await loadFixture(deployContractsFixture);
      expect(await flashArbitrage.FACTORY()).to.equal(await pancakeFactory.getAddress());
    });

    it('should initialize with zero profits', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);
      expect(await flashArbitrage.totalProfits()).to.equal(0);
    });

    it('should initialize with default swap deadline', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);
      expect(await flashArbitrage.swapDeadline()).to.equal(60); // DEFAULT_SWAP_DEADLINE
    });

    it('should revert on zero factory address', async () => {
      const [owner] = await ethers.getSigners();
      const PancakeSwapFlashArbitrageFactory = await ethers.getContractFactory(
        'PancakeSwapFlashArbitrage'
      );
      await expect(
        PancakeSwapFlashArbitrageFactory.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: PancakeSwapFlashArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });
  });

  // ===========================================================================
  // Admin Functions Tests (shared harness — eliminates ~200 LOC of duplication)
  // ===========================================================================
  const adminConfig: AdminTestConfig = {
    contractName: 'PancakeSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.flashArbitrage,
        owner: f.owner,
        user: f.user,
        attacker: f.attacker,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
      };
    },
  };

  testRouterManagement(adminConfig);
  testMinimumProfitConfig(adminConfig);
  testSwapDeadlineConfig(adminConfig);
  testPauseUnpause(adminConfig);
  testWithdrawToken(adminConfig);
  testWithdrawETH(adminConfig);
  testWithdrawGasLimitConfig(adminConfig);
  testOwnable2Step(adminConfig);

  // ===========================================================================
  // Pool Management Tests (PancakeSwap-specific)
  // ===========================================================================
  describe('Pool Management', () => {
    it('should correctly whitelist pool', async () => {
      const { flashArbitrage, wethUsdcPool } = await loadFixture(deployContractsFixture);

      await expect(flashArbitrage.whitelistPool(await wethUsdcPool.getAddress()))
        .to.emit(flashArbitrage, 'PoolWhitelisted')
        .withArgs(await wethUsdcPool.getAddress());

      expect(await flashArbitrage.isPoolWhitelisted(await wethUsdcPool.getAddress())).to.be.true;
    });

    it('should correctly remove pool from whitelist', async () => {
      const { flashArbitrage, wethUsdcPool, usdcDaiPool } = await loadFixture(
        deployContractsFixture
      );

      // Whitelist two pools
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());
      await flashArbitrage.whitelistPool(await usdcDaiPool.getAddress());

      // Verify both are whitelisted
      expect(await flashArbitrage.isPoolWhitelisted(await wethUsdcPool.getAddress())).to.be.true;
      expect(await flashArbitrage.isPoolWhitelisted(await usdcDaiPool.getAddress())).to.be.true;

      // Remove wethUsdcPool
      await expect(flashArbitrage.removePoolFromWhitelist(await wethUsdcPool.getAddress()))
        .to.emit(flashArbitrage, 'PoolRemovedFromWhitelist')
        .withArgs(await wethUsdcPool.getAddress());

      // Verify wethUsdcPool is removed, usdcDaiPool still whitelisted
      expect(await flashArbitrage.isPoolWhitelisted(await wethUsdcPool.getAddress())).to.be.false;
      expect(await flashArbitrage.isPoolWhitelisted(await usdcDaiPool.getAddress())).to.be.true;

      // Verify getWhitelistedPools returns correct list
      const pools = await flashArbitrage.getWhitelistedPools();
      expect(pools.length).to.equal(1);
      expect(pools[0]).to.equal(await usdcDaiPool.getAddress());
    });

    it('should revert when removing non-whitelisted pool', async () => {
      const { flashArbitrage, wethUsdcPool } = await loadFixture(deployContractsFixture);

      await expect(
        flashArbitrage.removePoolFromWhitelist(await wethUsdcPool.getAddress())
      ).to.be.revertedWithCustomError(flashArbitrage, 'PoolNotWhitelisted');
    });

    it('should revert when whitelisting already whitelisted pool', async () => {
      const { flashArbitrage, wethUsdcPool } = await loadFixture(deployContractsFixture);

      // Whitelist pool
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Try to whitelist again
      await expect(
        flashArbitrage.whitelistPool(await wethUsdcPool.getAddress())
      ).to.be.revertedWithCustomError(flashArbitrage, 'PoolAlreadyWhitelisted');
    });

    it('should revert when whitelisting zero address', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      await expect(
        flashArbitrage.whitelistPool(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(flashArbitrage, 'InvalidProtocolAddress');
    });
  });

  // ===========================================================================
  // Flash Loan Execution Tests
  // ===========================================================================
  describe('Flash Loan Execution', () => {
    it('should execute a profitable flash loan arbitrage (happy path)', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, dexRouter2, weth, usdc, owner } =
        await loadFixture(deployContractsFixture);

      // Setup: approve routers and whitelist pool
      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.addApprovedRouter(await dexRouter2.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Configure exchange rates for a profitable arbitrage:
      // Router1: 1 WETH -> 2000 USDC
      // Router2: 2000 USDC -> 1.02 WETH (slightly more than 1 WETH = ~2% profit)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)  // rate: 2000 USDC per WETH
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_2PCT_PROFIT  // ~1.02 WETH per 2000 USDC (0.00051 WETH per USDC)
      );

      const flashAmount = ethers.parseEther('10');
      const swapPath = build2HopCrossRouterPath(
        await dexRouter1.getAddress(), await dexRouter2.getAddress(),
        await weth.getAddress(), await usdc.getAddress(),
        ethers.parseUnits('19000', 6), ethers.parseEther('9.5')
      );
      const deadline = await getDeadline();

      // Record pool balance before to verify flash loan repayment
      const poolBalanceBefore = await weth.balanceOf(await wethUsdcPool.getAddress());

      // Execute the arbitrage
      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          flashAmount,
          swapPath,
          0, // minProfit
          deadline
        )
      ).to.emit(flashArbitrage, 'ArbitrageExecuted');

      // Verify pool was repaid (balance >= before, since pool gets back amount + fee)
      const poolBalanceAfter = await weth.balanceOf(await wethUsdcPool.getAddress());
      expect(poolBalanceAfter).to.be.gte(poolBalanceBefore);

      // Verify profit was tracked
      const totalProfits = await flashArbitrage.totalProfits();
      expect(totalProfits).to.be.gt(0);

      // Verify contract received the profit
      const contractBalance = await weth.balanceOf(await flashArbitrage.getAddress());
      expect(contractBalance).to.be.gt(0);
    });

    it('should revert when flash loan profit is insufficient', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth, usdc, owner } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Configure exchange rates for unprofitable arbitrage (1:1 swap, no profit)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('500000000000000')  // 1 USDC -> 0.0005 WETH (exact 1:1, no profit to cover fee)
      );

      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
      const deadline = await getDeadline();

      // Should revert because profit doesn't cover the 0.25% flash loan fee
      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'InsufficientProfit');
    });

    it('should revert when pool has zero liquidity', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Set pool liquidity to zero
      await wethUsdcPool.setLiquidity(0);

      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
      const deadline = await getDeadline();

      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'InsufficientPoolLiquidity');
    });
  });

  // ===========================================================================
  // Calculate Expected Profit Tests
  // ===========================================================================
  describe('Calculate Expected Profit', () => {
    it('should calculate expected profit correctly with 0.25% fee', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Configure rates for ~1% profit
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT // ~1% profit
      );

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('19000', 6),
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9.9'),
        },
      ];

      const [profit, fee] = await flashArbitrage.calculateExpectedProfit(
        await wethUsdcPool.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath
      );

      // Fee should be 0.25% of 10 WETH = 0.025 WETH
      // 10 WETH * 2500 / 1e6 = 0.025 WETH
      const expectedFee = ethers.parseEther('0.025');
      expect(fee).to.equal(expectedFee);

      // Profit should be > 0 (exact amount depends on mock router logic)
      expect(profit).to.be.gt(0);
    });

    it('should return 0 profit for invalid swap path', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth, usdc, dai } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());

      // Invalid path: doesn't end with starting token
      const invalidPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('19000', 6),
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: ethers.parseEther('19000'),
        },
      ];

      const [profit, fee] = await flashArbitrage.calculateExpectedProfit(
        await wethUsdcPool.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('10'),
        invalidPath
      );

      expect(profit).to.equal(0);
      expect(fee).to.be.gt(0); // Fee should still be calculated
    });
  });

  // ===========================================================================
  // Pause Functionality Tests
  // ===========================================================================
  // Note: Basic pause/unpause tests covered by shared admin harness (testPauseUnpause)
  describe('Pause — PancakeSwap-Specific', () => {
    it('should revert executeArbitrage when paused', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth } = await loadFixture(
        deployContractsFixture
      );

      // Setup first (before pausing)
      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Now pause
      await flashArbitrage.pause();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = await getDeadline();

      // Should fail because contract is paused
      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          1,
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWith('Pausable: paused');
    });
  });

  // ===========================================================================
  // Security Tests
  // ===========================================================================
  describe('Security', () => {
    it('should reject flash loan from non-whitelisted pool', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth, usdc } =
        await loadFixture(deployContractsFixture);

      // Setup routers but DON'T whitelist pool
      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());

      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
      const deadline = await getDeadline();

      // Should fail because pool is not whitelisted
      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'PoolNotWhitelisted');
    });

    it('should reject callback from non-whitelisted pool', async () => {
      const { flashArbitrage, pancakeFactory, weth, usdc } = await loadFixture(
        deployContractsFixture
      );

      // Create a new pool but don't whitelist it
      await pancakeFactory.createPool(await weth.getAddress(), await usdc.getAddress(), 500);
      const newPoolAddress = await pancakeFactory.getPool(
        await weth.getAddress(),
        await usdc.getAddress(),
        500
      );
      const newPool = await ethers.getContractAt('MockPancakeV3Pool', newPoolAddress);

      // Try to call callback directly from non-whitelisted pool
      // This simulates an attacker trying to call the callback
      const [attacker] = await ethers.getSigners();
      await expect(
        flashArbitrage.connect(attacker).pancakeV3FlashCallback(100, 0, '0x')
      ).to.be.revertedWithCustomError(flashArbitrage, 'InvalidFlashLoanCaller');
    });

    it('should reject transaction with stale deadline', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      // Use a deadline in the past
      const staleDeadline = (await ethers.provider.getBlock('latest'))!.timestamp - 1;

      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          staleDeadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'TransactionTooOld');
    });

    it('should reject zero amount flash loan', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 0,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          0, // Zero amount
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'InvalidAmount');
    });

    it('should reject swap path with unapproved router', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      // Only approve router1, not router2
      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1,
        },
        {
          router: await dexRouter2.getAddress(), // Unapproved!
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'RouterNotApproved');
    });

    it('should prevent reentrancy attacks via malicious router', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth, usdc, owner } =
        await loadFixture(deployContractsFixture);

      // Deploy malicious router that tries reentrancy during swap execution
      const MaliciousRouterFactory = await ethers.getContractFactory('MockMaliciousRouter');
      const maliciousRouter = await MaliciousRouterFactory.deploy(
        await flashArbitrage.getAddress()
      );

      await flashArbitrage.addApprovedRouter(await maliciousRouter.getAddress());
      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Fund the malicious router with enough tokens (1:1 passthrough)
      await weth.mint(await maliciousRouter.getAddress(), ethers.parseEther('100'));
      await usdc.mint(await maliciousRouter.getAddress(), ethers.parseEther('100'));

      // Set favorable exchange rate on dexRouter1 for the 2nd hop to generate profit.
      // The malicious router does 1:1 passthrough, so we need the 2nd hop to be profitable
      // to cover PancakeSwap's 0.25% flash loan fee (2500 bps).
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('1.01')
      );

      // Path: WETH→USDC (malicious, 1:1 + reentrancy) → USDC→WETH (normal, 1% profit)
      const swapPath = build2HopCrossRouterPath(
        await maliciousRouter.getAddress(), await dexRouter1.getAddress(),
        await weth.getAddress(), await usdc.getAddress(), 1n, 1n
      );

      const deadline = await getDeadline();
      await flashArbitrage.executeArbitrage(
        await wethUsdcPool.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('1'),
        swapPath,
        0,
        deadline
      );

      // Verify the attack was actually attempted and blocked
      expect(await maliciousRouter.attackAttempted()).to.be.true;
      expect(await maliciousRouter.attackSucceeded()).to.be.false;
    });

    it('should enforce minimum slippage protection', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Swap path with amountOutMin = 0 (no slippage protection)
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 0, // No slippage protection!
        },
      ];

      const deadline = await getDeadline();

      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'InsufficientSlippageProtection');
    });
  });

  // ===========================================================================
  // Fund Recovery Tests
  // ===========================================================================
  // ===========================================================================
  // Batch Pool Whitelisting Tests (whitelistMultiplePools)
  // ===========================================================================
  describe('Batch Pool Whitelisting', () => {
    it('should revert on empty pools array', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      await expect(
        flashArbitrage.whitelistMultiplePools([])
      ).to.be.revertedWithCustomError(flashArbitrage, 'EmptyPoolsArray');
    });

    it('should revert when batch exceeds MAX_BATCH_WHITELIST', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      // Create array of 101 random addresses (MAX_BATCH_WHITELIST = 100)
      const pools = Array.from({ length: 101 }, () => ethers.Wallet.createRandom().address);

      await expect(
        flashArbitrage.whitelistMultiplePools(pools)
      ).to.be.revertedWithCustomError(flashArbitrage, 'BatchTooLarge')
        .withArgs(101, 100);
    });

    it('should whitelist multiple pools and return success count', async () => {
      const { flashArbitrage, wethUsdcPool, usdcDaiPool } = await loadFixture(
        deployContractsFixture
      );

      const pools = [await wethUsdcPool.getAddress(), await usdcDaiPool.getAddress()];

      const tx = await flashArbitrage.whitelistMultiplePools(pools);
      const receipt = await tx.wait();

      // Both pools should be whitelisted
      expect(await flashArbitrage.isPoolWhitelisted(pools[0])).to.be.true;
      expect(await flashArbitrage.isPoolWhitelisted(pools[1])).to.be.true;

      // Should emit PoolWhitelisted for each
      await expect(tx)
        .to.emit(flashArbitrage, 'PoolWhitelisted')
        .withArgs(pools[0]);
      await expect(tx)
        .to.emit(flashArbitrage, 'PoolWhitelisted')
        .withArgs(pools[1]);
    });

    it('should skip zero addresses without reverting', async () => {
      const { flashArbitrage, wethUsdcPool } = await loadFixture(deployContractsFixture);

      const poolAddress = await wethUsdcPool.getAddress();
      const pools = [ethers.ZeroAddress, poolAddress, ethers.ZeroAddress];

      await flashArbitrage.whitelistMultiplePools(pools);

      // Only non-zero pool should be whitelisted
      expect(await flashArbitrage.isPoolWhitelisted(poolAddress)).to.be.true;
    });

    it('should skip duplicate pools without reverting', async () => {
      const { flashArbitrage, wethUsdcPool } = await loadFixture(deployContractsFixture);

      const poolAddress = await wethUsdcPool.getAddress();
      const pools = [poolAddress, poolAddress, poolAddress];

      // Should not revert — duplicates silently skipped
      await flashArbitrage.whitelistMultiplePools(pools);

      expect(await flashArbitrage.isPoolWhitelisted(poolAddress)).to.be.true;

      // Only 1 pool in the whitelist despite 3 inputs
      const whitelisted = await flashArbitrage.getWhitelistedPools();
      expect(whitelisted.length).to.equal(1);
    });

    it('should only allow owner to batch whitelist', async () => {
      const { flashArbitrage, wethUsdcPool, user } = await loadFixture(deployContractsFixture);

      await expect(
        flashArbitrage.connect(user).whitelistMultiplePools([await wethUsdcPool.getAddress()])
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should accept exactly MAX_BATCH_WHITELIST pools', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      // Create array of exactly 100 random addresses
      const pools = Array.from({ length: 100 }, () => ethers.Wallet.createRandom().address);

      // Should not revert at the limit
      await flashArbitrage.whitelistMultiplePools(pools);

      // Verify all 100 are whitelisted
      expect(await flashArbitrage.isPoolWhitelisted(pools[0])).to.be.true;
      expect(await flashArbitrage.isPoolWhitelisted(pools[99])).to.be.true;
    });
  });

  // ===========================================================================
  // PoolNotFromFactory Security Test
  // ===========================================================================
  describe('Pool Factory Verification', () => {
    it('should revert when whitelisted pool is not registered in factory', async () => {
      const { flashArbitrage, pancakeFactory, dexRouter1, weth, usdc } = await loadFixture(
        deployContractsFixture
      );

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());

      // Deploy a standalone MockPancakeV3Pool that is NOT registered in the factory
      const MockPancakeV3PoolFactory = await ethers.getContractFactory('MockPancakeV3Pool');
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const [token0, token1] = wethAddr.toLowerCase() < usdcAddr.toLowerCase()
        ? [wethAddr, usdcAddr]
        : [usdcAddr, wethAddr];

      const fakePool = await MockPancakeV3PoolFactory.deploy(
        token0,
        token1,
        2500,
        await pancakeFactory.getAddress()
      );

      // Whitelist the fake pool (passes whitelist check)
      await flashArbitrage.whitelistPool(await fakePool.getAddress());

      // Fund the fake pool with tokens for the flash loan
      await weth.mint(await fakePool.getAddress(), ethers.parseEther('100'));
      await usdc.mint(await fakePool.getAddress(), ethers.parseUnits('200000', 6));

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = await getDeadline();

      // Should revert because factory.getPool() won't return this pool's address
      await expect(
        flashArbitrage.executeArbitrage(
          await fakePool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(flashArbitrage, 'PoolNotFromFactory');
    });
  });

  // ===========================================================================
  // FlashLoanNotActive Security Test
  // ===========================================================================
  describe('Flash Loan Context Guard', () => {
    it('should revert when callback called with invalid data by whitelisted pool', async () => {
      const { flashArbitrage, wethUsdcPool, owner } = await loadFixture(
        deployContractsFixture
      );

      // Whitelist the pool so it passes the whitelist check
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // Impersonate the pool to call pancakeV3FlashCallback directly
      const poolAddress = await wethUsdcPool.getAddress();
      await ethers.provider.send('hardhat_impersonateAccount', [poolAddress]);
      await owner.sendTransaction({ to: poolAddress, value: ethers.parseEther('1') });
      const poolSigner = await ethers.getSigner(poolAddress);

      // Call callback directly with empty data — abi.decode fails
      // Context is now passed via calldata, so invalid/empty data causes decode revert
      await expect(
        flashArbitrage.connect(poolSigner).pancakeV3FlashCallback(100, 0, '0x')
      ).to.be.revertedWithoutReason();

      await ethers.provider.send('hardhat_stopImpersonatingAccount', [poolAddress]);
    });
  });

  // ===========================================================================
  // Multi-Hop Execution Tests
  // ===========================================================================
  describe('Multi-Hop Execution', () => {
    it('should execute 3-hop triangular arbitrage', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, dexRouter2, weth, usdc, dai } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.addApprovedRouter(await dexRouter2.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      // WETH -> USDC -> DAI -> WETH (triangular arbitrage)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1010000000000000000000000000000')
      );
      await dexRouter2.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        BigInt('510000000000000')
      );

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('19000', 6),
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: ethers.parseEther('19000'),
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9'),
        },
      ];

      const deadline = await getDeadline();

      await expect(
        flashArbitrage.executeArbitrage(
          await wethUsdcPool.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath,
          0,
          deadline
        )
      ).to.emit(flashArbitrage, 'ArbitrageExecuted');

      // Verify profit
      const contractBalance = await weth.balanceOf(await flashArbitrage.getAddress());
      expect(contractBalance).to.be.gt(0);
    });
  });

  // ===========================================================================
  // Gas Benchmark Tests
  // ===========================================================================
  describe('Gas Benchmarks', () => {
    it('should execute 2-hop arbitrage within gas budget', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.addApprovedRouter(await dexRouter2.getAddress());
      await flashArbitrage.whitelistPool(await wethUsdcPool.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_2PCT_PROFIT
      );

      const swapPath = build2HopCrossRouterPath(
        await dexRouter1.getAddress(), await dexRouter2.getAddress(),
        await weth.getAddress(), await usdc.getAddress(), 1n, 1n
      );
      const deadline = await getDeadline();

      const tx = await flashArbitrage.executeArbitrage(
        await wethUsdcPool.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );
      const receipt = await tx.wait();

      // PancakeSwap V3 flash loan + 2 swaps should be < 500,000 gas
      expect(receipt!.gasUsed).to.be.lt(500_000);
    });
  });
});
