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
    const [owner, user, attacker] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const weth = await MockERC20Factory.deploy('Wrapped Ether', 'WETH', 18);
    const usdc = await MockERC20Factory.deploy('USD Coin', 'USDC', 6);
    const dai = await MockERC20Factory.deploy('Dai Stablecoin', 'DAI', 18);

    // Deploy mock PancakeSwap V3 factory
    const MockPancakeV3FactoryFactory = await ethers.getContractFactory('MockPancakeV3Factory');
    const pancakeFactory = await MockPancakeV3FactoryFactory.deploy();

    // Create WETH/USDC pool with 0.25% fee (2500 bps - most common)
    const wethAddress = await weth.getAddress();
    const usdcAddress = await usdc.getAddress();
    await pancakeFactory.createPool(wethAddress, usdcAddress, 2500);
    const wethUsdcPoolAddress = await pancakeFactory.getPool(wethAddress, usdcAddress, 2500);
    const wethUsdcPool = await ethers.getContractAt('MockPancakeV3Pool', wethUsdcPoolAddress);

    // Create USDC/DAI pool with 0.01% fee (100 bps - stablecoin pair)
    const daiAddress = await dai.getAddress();
    await pancakeFactory.createPool(usdcAddress, daiAddress, 100);
    const usdcDaiPoolAddress = await pancakeFactory.getPool(usdcAddress, daiAddress, 100);
    const usdcDaiPool = await ethers.getContractAt('MockPancakeV3Pool', usdcDaiPoolAddress);

    // Deploy mock DEX routers (2 routers for arbitrage)
    const MockDexRouterFactory = await ethers.getContractFactory('MockDexRouter');
    const dexRouter1 = await MockDexRouterFactory.deploy('Router1');
    const dexRouter2 = await MockDexRouterFactory.deploy('Router2');

    // Deploy PancakeSwapFlashArbitrage contract
    const PancakeSwapFlashArbitrageFactory = await ethers.getContractFactory(
      'PancakeSwapFlashArbitrage'
    );
    const flashArbitrage = await PancakeSwapFlashArbitrageFactory.deploy(
      await pancakeFactory.getAddress(),
      owner.address
    );

    // Setup mock token supplies in pools
    await weth.mint(wethUsdcPoolAddress, ethers.parseEther('10000'));
    await usdc.mint(wethUsdcPoolAddress, ethers.parseUnits('20000000', 6));
    await usdc.mint(usdcDaiPoolAddress, ethers.parseUnits('5000000', 6));
    await dai.mint(usdcDaiPoolAddress, ethers.parseEther('5000000'));

    // Fund DEX routers for swaps
    await weth.mint(await dexRouter1.getAddress(), ethers.parseEther('1000'));
    await weth.mint(await dexRouter2.getAddress(), ethers.parseEther('1000'));
    await usdc.mint(await dexRouter1.getAddress(), ethers.parseUnits('1000000', 6));
    await usdc.mint(await dexRouter2.getAddress(), ethers.parseUnits('1000000', 6));
    await dai.mint(await dexRouter1.getAddress(), ethers.parseEther('1000000'));
    await dai.mint(await dexRouter2.getAddress(), ethers.parseEther('1000000'));

    return {
      flashArbitrage,
      pancakeFactory,
      wethUsdcPool,
      usdcDaiPool,
      dexRouter1,
      dexRouter2,
      weth,
      usdc,
      dai,
      owner,
      user,
      attacker,
    };
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
  // Access Control Tests
  // ===========================================================================
  describe('Access Control', () => {
    it('should only allow owner to add approved routers', async () => {
      const { flashArbitrage, dexRouter1, user } = await loadFixture(deployContractsFixture);

      const userContract = flashArbitrage.connect(user) as PancakeSwapFlashArbitrage;
      await expect(
        userContract.addApprovedRouter(await dexRouter1.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should allow owner to add approved routers', async () => {
      const { flashArbitrage, dexRouter1 } = await loadFixture(deployContractsFixture);

      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      expect(await flashArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
    });

    it('should only allow owner to whitelist pools', async () => {
      const { flashArbitrage, wethUsdcPool, user } = await loadFixture(deployContractsFixture);

      const userContract = flashArbitrage.connect(user) as PancakeSwapFlashArbitrage;
      await expect(
        userContract.whitelistPool(await wethUsdcPool.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should only allow owner to withdraw profits', async () => {
      const { flashArbitrage, weth, user } = await loadFixture(deployContractsFixture);

      const userContract = flashArbitrage.connect(user) as PancakeSwapFlashArbitrage;
      await expect(
        userContract.withdrawToken(await weth.getAddress(), user.address, 100)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should only allow owner to set minimum profit', async () => {
      const { flashArbitrage, user } = await loadFixture(deployContractsFixture);

      const userContract = flashArbitrage.connect(user) as PancakeSwapFlashArbitrage;
      await expect(userContract.setMinimumProfit(1000)).to.be.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('should only allow owner to pause/unpause', async () => {
      const { flashArbitrage, user } = await loadFixture(deployContractsFixture);

      const userContract = flashArbitrage.connect(user) as PancakeSwapFlashArbitrage;
      await expect(userContract.pause()).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  // ===========================================================================
  // Router Management Tests
  // ===========================================================================
  describe('Router Management', () => {
    it('should correctly add and query router', async () => {
      const { flashArbitrage, dexRouter1 } = await loadFixture(deployContractsFixture);

      await expect(flashArbitrage.addApprovedRouter(await dexRouter1.getAddress()))
        .to.emit(flashArbitrage, 'RouterAdded')
        .withArgs(await dexRouter1.getAddress());

      expect(await flashArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
    });

    it('should correctly remove approved router', async () => {
      const { flashArbitrage, dexRouter1, dexRouter2 } = await loadFixture(deployContractsFixture);

      // Add two routers
      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Verify both are approved
      expect(await flashArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
      expect(await flashArbitrage.isApprovedRouter(await dexRouter2.getAddress())).to.be.true;

      // Remove router1
      await expect(flashArbitrage.removeApprovedRouter(await dexRouter1.getAddress()))
        .to.emit(flashArbitrage, 'RouterRemoved')
        .withArgs(await dexRouter1.getAddress());

      // Verify router1 is removed, router2 still approved
      expect(await flashArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.false;
      expect(await flashArbitrage.isApprovedRouter(await dexRouter2.getAddress())).to.be.true;

      // Verify getApprovedRouters returns correct list
      const routers = await flashArbitrage.getApprovedRouters();
      expect(routers.length).to.equal(1);
      expect(routers[0]).to.equal(await dexRouter2.getAddress());
    });

    it('should revert when removing unapproved router', async () => {
      const { flashArbitrage, dexRouter1 } = await loadFixture(deployContractsFixture);

      await expect(
        flashArbitrage.removeApprovedRouter(await dexRouter1.getAddress())
      ).to.be.revertedWithCustomError(flashArbitrage, 'RouterNotApproved');
    });

    it('should revert when adding already approved router', async () => {
      const { flashArbitrage, dexRouter1 } = await loadFixture(deployContractsFixture);

      // Add router
      await flashArbitrage.addApprovedRouter(await dexRouter1.getAddress());

      // Try to add again
      await expect(
        flashArbitrage.addApprovedRouter(await dexRouter1.getAddress())
      ).to.be.revertedWithCustomError(flashArbitrage, 'RouterAlreadyApproved');
    });

    it('should revert when adding zero address as router', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      await expect(
        flashArbitrage.addApprovedRouter(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(flashArbitrage, 'InvalidRouterAddress');
    });
  });

  // ===========================================================================
  // Pool Management Tests
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
  // Minimum Profit Configuration Tests
  // ===========================================================================
  describe('Minimum Profit Configuration', () => {
    it('should allow owner to set minimum profit', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      const newMinProfit = ethers.parseEther('0.1');
      await expect(flashArbitrage.setMinimumProfit(newMinProfit))
        .to.emit(flashArbitrage, 'MinimumProfitUpdated')
        .withArgs(0, newMinProfit);

      expect(await flashArbitrage.minimumProfit()).to.equal(newMinProfit);
    });
  });

  // ===========================================================================
  // Swap Deadline Configuration Tests
  // ===========================================================================
  describe('Swap Deadline Configuration', () => {
    it('should allow owner to set swap deadline', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      const newDeadline = 600; // 10 minutes
      await expect(flashArbitrage.setSwapDeadline(newDeadline))
        .to.emit(flashArbitrage, 'SwapDeadlineUpdated')
        .withArgs(60, newDeadline);

      expect(await flashArbitrage.swapDeadline()).to.equal(newDeadline);
    });

    it('should revert when setting deadline to 0', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      await expect(flashArbitrage.setSwapDeadline(0)).to.be.revertedWithCustomError(
        flashArbitrage,
        'InvalidSwapDeadline'
      );
    });

    it('should revert when setting deadline > MAX_SWAP_DEADLINE', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      await expect(flashArbitrage.setSwapDeadline(601)).to.be.revertedWithCustomError(
        flashArbitrage,
        'InvalidSwapDeadline'
      );
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
        BigInt('510000000000000000000000000')  // ~1.02 WETH per 2000 USDC (0.00051 WETH per USDC)
      );

      const flashAmount = ethers.parseEther('10');
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
          amountOutMin: ethers.parseEther('9.5'),
        },
      ];

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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
        BigInt('505000000000000000000000000') // ~1% profit
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
  describe('Pause Functionality', () => {
    it('should allow owner to pause contract', async () => {
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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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

    it('should allow owner to unpause contract', async () => {
      const { flashArbitrage } = await loadFixture(deployContractsFixture);

      await flashArbitrage.pause();
      await flashArbitrage.unpause();

      // Contract should be usable again
      // (Full execution test in next section)
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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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
  describe('Fund Recovery', () => {
    it('should allow owner to withdraw ERC20 tokens', async () => {
      const { flashArbitrage, weth, owner } = await loadFixture(deployContractsFixture);

      // Send some WETH to contract
      const amount = ethers.parseEther('1');
      await weth.mint(await flashArbitrage.getAddress(), amount);

      // Withdraw
      await expect(
        flashArbitrage.withdrawToken(await weth.getAddress(), owner.address, amount)
      )
        .to.emit(flashArbitrage, 'TokenWithdrawn')
        .withArgs(await weth.getAddress(), owner.address, amount);

      expect(await weth.balanceOf(owner.address)).to.equal(amount);
    });

    it('should allow owner to withdraw ETH', async () => {
      const { flashArbitrage, owner } = await loadFixture(deployContractsFixture);

      // Send some ETH to contract
      const amount = ethers.parseEther('1');
      await owner.sendTransaction({
        to: await flashArbitrage.getAddress(),
        value: amount,
      });

      const balanceBefore = await ethers.provider.getBalance(owner.address);

      // Withdraw
      const tx = await flashArbitrage.withdrawETH(owner.address, amount);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * BigInt(receipt!.gasPrice ?? 0);

      const balanceAfter = await ethers.provider.getBalance(owner.address);

      // Balance should increase by amount minus gas
      expect(balanceAfter).to.equal(balanceBefore + amount - gasUsed);
    });

    it('should revert when withdrawing to zero address', async () => {
      const { flashArbitrage, weth } = await loadFixture(deployContractsFixture);

      await expect(
        flashArbitrage.withdrawToken(await weth.getAddress(), ethers.ZeroAddress, 100)
      ).to.be.revertedWithCustomError(flashArbitrage, 'InvalidRecipient');
    });
  });

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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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
    it('should revert when callback called without active flash loan context', async () => {
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

      // Call callback directly — _flashContext.active is false
      await expect(
        flashArbitrage.connect(poolSigner).pancakeV3FlashCallback(100, 0, '0x')
      ).to.be.revertedWithCustomError(flashArbitrage, 'FlashLoanNotActive');

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

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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
  // Ownable2Step Tests
  // ===========================================================================
  describe('Ownable2Step', () => {
    it('should support two-step ownership transfer', async () => {
      const { flashArbitrage, owner, user } = await loadFixture(deployContractsFixture);

      // Step 1: Initiate transfer
      await flashArbitrage.connect(owner).transferOwnership(user.address);
      expect(await flashArbitrage.owner()).to.equal(owner.address);
      expect(await flashArbitrage.pendingOwner()).to.equal(user.address);

      // Step 2: Accept ownership
      await flashArbitrage.connect(user).acceptOwnership();
      expect(await flashArbitrage.owner()).to.equal(user.address);
    });

    it('should not allow non-pending owner to accept', async () => {
      const { flashArbitrage, owner, user, attacker } = await loadFixture(deployContractsFixture);

      await flashArbitrage.connect(owner).transferOwnership(user.address);

      await expect(
        flashArbitrage.connect(attacker).acceptOwnership()
      ).to.be.revertedWith('Ownable2Step: caller is not the new owner');
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
        BigInt('510000000000000000000000000')
      );

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1,
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 300;

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
