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
  testDeploymentDefaults,
  testInputValidation,
  testCalculateExpectedProfit,
  testReentrancyProtection,
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

  // Module-level variable to share pool address with triggerArbitrage callback
  let cachedPoolAddress: string;

  // ===========================================================================
  // Deployment Defaults (shared) + PancakeSwap-Specific Deployment
  // ===========================================================================
  testDeploymentDefaults({
    contractName: 'PancakeSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return { contract: f.flashArbitrage, owner: f.owner };
    },
  });

  describe('Deployment — PancakeSwap-Specific', () => {
    it('should set correct factory address', async () => {
      const { flashArbitrage, pancakeFactory } = await loadFixture(deployContractsFixture);
      expect(await flashArbitrage.FACTORY()).to.equal(await pancakeFactory.getAddress());
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
  // Input Validation (shared — _validateArbitrageParams)
  // ===========================================================================
  testInputValidation({
    contractName: 'PancakeSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      cachedPoolAddress = await f.wethUsdcPool.getAddress();
      // Pre-whitelist the pool so base validation tests can reach _validateArbitrageParams
      await f.flashArbitrage.connect(f.owner).whitelistPool(cachedPoolAddress);
      return {
        contract: f.flashArbitrage,
        owner: f.owner,
        user: f.user,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
        usdc: f.usdc,
        dai: f.dai,
      };
    },
    triggerArbitrage: (contract, signer, params) =>
      contract.connect(signer).executeArbitrage(
        cachedPoolAddress, params.asset, params.amount, params.swapPath, params.minProfit, params.deadline
      ),
  });

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
  // Calculate Expected Profit (shared + PancakeSwap-specific)
  // ===========================================================================

  // PancakeSwap requires pool address — reuse cachedPoolAddress from fixture closure
  testCalculateExpectedProfit({
    contractName: 'PancakeSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      cachedPoolAddress = await f.wethUsdcPool.getAddress();
      return {
        contract: f.flashArbitrage,
        owner: f.owner,
        dexRouter1: f.dexRouter1,
        weth: f.weth,
        usdc: f.usdc,
      };
    },
    triggerCalculateProfit: async (contract, params) => {
      const [expectedProfit, flashLoanFee] = await contract.calculateExpectedProfit(
        cachedPoolAddress, params.asset, params.amount, params.swapPath
      );
      return { expectedProfit, flashLoanFee };
    },
    profitableReverseRate: RATE_USDC_TO_WETH_1PCT_PROFIT,
  });

  describe('Calculate Expected Profit — PancakeSwap-Specific', () => {
    it('should calculate PancakeSwap V3 fee as 0.25%', async () => {
      const { flashArbitrage, wethUsdcPool, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.addApprovedRouter(await dexRouter2.getAddress());
      await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
      await dexRouter2.setExchangeRate(await usdc.getAddress(), await weth.getAddress(), RATE_USDC_TO_WETH_1PCT_PROFIT);

      const [, fee] = await flashArbitrage.calculateExpectedProfit(
        await wethUsdcPool.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('10'),
        [
          { router: await dexRouter1.getAddress(), tokenIn: await weth.getAddress(), tokenOut: await usdc.getAddress(), amountOutMin: 1n },
          { router: await dexRouter2.getAddress(), tokenIn: await usdc.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1n },
        ]
      );

      // Fee should be 0.25% of 10 WETH = 0.025 WETH
      expect(fee).to.equal(ethers.parseEther('0.025'));
    });
  });

  // ===========================================================================
  // Security Tests (PancakeSwap-specific)
  // ===========================================================================
  // Note: Base validation tests (stale deadline, zero amount, unapproved router,
  // slippage protection, paused state) are covered by testInputValidation above.
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

  });

  // ===========================================================================
  // Reentrancy Protection (shared — MockMaliciousRouter)
  // ===========================================================================
  testReentrancyProtection({
    contractName: 'PancakeSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.flashArbitrage,
        owner: f.owner,
        user: f.user,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
        usdc: f.usdc,
        dai: f.dai,
        wethUsdcPool: f.wethUsdcPool,
      };
    },
    triggerWithMaliciousRouter: async (fixture, maliciousRouterAddress) => {
      const { contract, owner, dexRouter1, weth, usdc, wethUsdcPool } = fixture as any;

      // PancakeSwap requires pool whitelisting
      const poolAddress = await wethUsdcPool.getAddress();
      await contract.connect(owner).whitelistPool(poolAddress);
      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set profitable rate on 2nd hop so the tx doesn't revert for lack of profit
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('1.01'),
      );

      const swapPath = [
        {
          router: maliciousRouterAddress,
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      // PancakeSwap uses 6-param executeArbitrage (pool, asset, amount, path, minProfit, deadline)
      await contract.executeArbitrage(
        poolAddress,
        await weth.getAddress(),
        ethers.parseEther('1'),
        swapPath,
        0,
        deadline,
      );
    },
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
