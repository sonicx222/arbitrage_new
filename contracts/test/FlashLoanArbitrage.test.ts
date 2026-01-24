import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { FlashLoanArbitrage, MockAavePool, MockDexRouter, MockERC20 } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * FlashLoanArbitrage Contract Tests
 *
 * Tests follow TDD approach for Task 3.1.1:
 * - [x] Create base flash loan receiver contract
 * - [x] Implement Aave FlashLoanSimpleReceiverBase
 * - [x] Add multi-hop swap execution
 * - [x] Add profit verification and return
 *
 * @see implementation_plan_v2.md Task 3.1.1
 */
describe('FlashLoanArbitrage', () => {
  // Test fixtures for consistent state
  async function deployContractsFixture() {
    const [owner, user, attacker] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const weth = await MockERC20Factory.deploy('Wrapped Ether', 'WETH', 18);
    const usdc = await MockERC20Factory.deploy('USD Coin', 'USDC', 6);
    const dai = await MockERC20Factory.deploy('Dai Stablecoin', 'DAI', 18);

    // Deploy mock Aave pool
    const MockAavePoolFactory = await ethers.getContractFactory('MockAavePool');
    const aavePool = await MockAavePoolFactory.deploy();

    // Deploy mock DEX routers (2 routers for arbitrage)
    const MockDexRouterFactory = await ethers.getContractFactory('MockDexRouter');
    const dexRouter1 = await MockDexRouterFactory.deploy('Router1');
    const dexRouter2 = await MockDexRouterFactory.deploy('Router2');

    // Deploy FlashLoanArbitrage contract
    const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
    const flashLoanArbitrage = await FlashLoanArbitrageFactory.deploy(
      await aavePool.getAddress(),
      owner.address
    );

    // Setup mock token supplies
    await weth.mint(await aavePool.getAddress(), ethers.parseEther('10000'));
    await usdc.mint(await aavePool.getAddress(), ethers.parseUnits('10000000', 6));
    await dai.mint(await aavePool.getAddress(), ethers.parseEther('10000000'));

    // Fund DEX routers for swaps
    await weth.mint(await dexRouter1.getAddress(), ethers.parseEther('1000'));
    await weth.mint(await dexRouter2.getAddress(), ethers.parseEther('1000'));
    await usdc.mint(await dexRouter1.getAddress(), ethers.parseUnits('1000000', 6));
    await usdc.mint(await dexRouter2.getAddress(), ethers.parseUnits('1000000', 6));
    await dai.mint(await dexRouter1.getAddress(), ethers.parseEther('1000000'));
    await dai.mint(await dexRouter2.getAddress(), ethers.parseEther('1000000'));

    return {
      flashLoanArbitrage,
      aavePool,
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
      const { flashLoanArbitrage, owner } = await loadFixture(deployContractsFixture);
      expect(await flashLoanArbitrage.owner()).to.equal(owner.address);
    });

    it('should set correct Aave pool address', async () => {
      const { flashLoanArbitrage, aavePool } = await loadFixture(deployContractsFixture);
      expect(await flashLoanArbitrage.POOL()).to.equal(await aavePool.getAddress());
    });

    it('should initialize with zero profits', async () => {
      const { flashLoanArbitrage } = await loadFixture(deployContractsFixture);
      expect(await flashLoanArbitrage.totalProfits()).to.equal(0);
    });

    it('should revert on zero pool address', async () => {
      const [owner] = await ethers.getSigners();
      const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
      await expect(
        FlashLoanArbitrageFactory.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWith('Invalid pool address');
    });
  });

  // ===========================================================================
  // Access Control Tests
  // ===========================================================================
  describe('Access Control', () => {
    it('should only allow owner to add approved routers', async () => {
      const { flashLoanArbitrage, dexRouter1, user } = await loadFixture(deployContractsFixture);

      await expect(
        flashLoanArbitrage.connect(user).addApprovedRouter(await dexRouter1.getAddress())
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'OwnableUnauthorizedAccount');
    });

    it('should allow owner to add approved routers', async () => {
      const { flashLoanArbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      expect(await flashLoanArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
    });

    it('should only allow owner to withdraw profits', async () => {
      const { flashLoanArbitrage, weth, user } = await loadFixture(deployContractsFixture);

      await expect(
        flashLoanArbitrage.connect(user).withdrawToken(await weth.getAddress(), user.address, 100)
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'OwnableUnauthorizedAccount');
    });

    it('should only allow owner to set minimum profit', async () => {
      const { flashLoanArbitrage, user } = await loadFixture(deployContractsFixture);

      await expect(
        flashLoanArbitrage.connect(user).setMinimumProfit(1000)
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'OwnableUnauthorizedAccount');
    });

    it('should only allow owner to pause/unpause', async () => {
      const { flashLoanArbitrage, user } = await loadFixture(deployContractsFixture);

      await expect(flashLoanArbitrage.connect(user).pause()).to.be.revertedWithCustomError(
        flashLoanArbitrage,
        'OwnableUnauthorizedAccount'
      );
    });
  });

  // ===========================================================================
  // Flash Loan Execution Tests
  // ===========================================================================
  describe('Flash Loan Execution', () => {
    it('should execute profitable arbitrage successfully', async () => {
      const { flashLoanArbitrage, aavePool, dexRouter1, dexRouter2, weth, usdc, owner } =
        await loadFixture(deployContractsFixture);

      // Setup: Add routers as approved
      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Setup: Configure DEX rates for profitable arbitrage
      // Router1: 1 WETH = 2000 USDC
      // Router2: 2010 USDC = 1.005 WETH (0.5% profit opportunity)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6) // 2000 USDC per WETH
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005') // 1 USDC = 0.0005 WETH
      );

      const flashLoanAmount = ethers.parseEther('10'); // 10 WETH
      const minProfit = ethers.parseEther('0.01'); // Minimum 0.01 WETH profit

      // Build swap path
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('19000', 6), // Expect ~20000 USDC, min 19000
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9.9'), // Expect ~10.05 WETH, min 9.9
        },
      ];

      // Execute flash loan arbitrage
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          minProfit
        )
      ).to.emit(flashLoanArbitrage, 'ArbitrageExecuted');
    });

    it('should revert when profit is below minimum', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      // Setup: Add routers
      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Setup: Configure DEX rates for unprofitable arbitrage (loss after fees)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.00049') // Slight loss
      );

      const flashLoanAmount = ethers.parseEther('10');
      const minProfit = ethers.parseEther('0.1'); // High minimum profit

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

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          minProfit
        )
      ).to.be.revertedWith('Profit below minimum');
    });

    it('should revert when using unapproved router', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      // Only approve router1, not router2
      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

      const flashLoanAmount = ethers.parseEther('10');
      const minProfit = ethers.parseEther('0.01');

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('19000', 6),
        },
        {
          router: await dexRouter2.getAddress(), // Not approved!
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9.9'),
        },
      ];

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          minProfit
        )
      ).to.be.revertedWith('Router not approved');
    });

    it('should revert when contract is paused', async () => {
      const { flashLoanArbitrage, dexRouter1, weth } = await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.pause();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 0,
        },
      ];

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath,
          0
        )
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'EnforcedPause');
    });
  });

  // ===========================================================================
  // Multi-Hop Swap Tests
  // ===========================================================================
  describe('Multi-Hop Swaps', () => {
    it('should execute 2-hop swap successfully', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc, owner } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Configure profitable rates
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.00051') // Profitable
      );

      const flashLoanAmount = ethers.parseEther('10');

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

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          ethers.parseEther('0.01')
        )
      ).to.emit(flashLoanArbitrage, 'ArbitrageExecuted');
    });

    it('should execute 3-hop swap (triangular arbitrage)', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc, dai, owner } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Configure rates for triangular arbitrage: WETH -> USDC -> DAI -> WETH
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6) // 1 WETH = 2000 USDC
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        ethers.parseEther('1.01') // 1 USDC = 1.01 DAI (slight premium)
      );
      await dexRouter2.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.000505') // 1 DAI = 0.000505 WETH (profitable)
      );

      const flashLoanAmount = ethers.parseEther('10');

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
          amountOutMin: ethers.parseEther('9.9'),
        },
      ];

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          ethers.parseEther('0.01')
        )
      ).to.emit(flashLoanArbitrage, 'ArbitrageExecuted');
    });

    it('should revert on empty swap path', async () => {
      const { flashLoanArbitrage, weth } = await loadFixture(deployContractsFixture);

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('10'),
          [], // Empty path
          0
        )
      ).to.be.revertedWith('Empty swap path');
    });

    it('should revert when swap output is below minimum', async () => {
      const { flashLoanArbitrage, dexRouter1, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

      // Set a low exchange rate
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('100', 6) // Only 100 USDC per WETH
      );

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('2000', 6), // Expect 2000, but will get 100
        },
      ];

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0
        )
      ).to.be.revertedWith('Insufficient output amount');
    });
  });

  // ===========================================================================
  // Profit Verification Tests
  // ===========================================================================
  describe('Profit Verification', () => {
    it('should correctly calculate profit after flash loan fee', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc, owner } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Aave V3 flash loan fee is 0.09%
      // For 10 WETH: fee = 0.009 WETH
      // We need profit > 0.009 WETH + minProfit

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.000505') // ~1% profit opportunity
      );

      const flashLoanAmount = ethers.parseEther('10');
      const minProfit = ethers.parseEther('0.05');

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

      const tx = await flashLoanArbitrage.executeArbitrage(
        await weth.getAddress(),
        flashLoanAmount,
        swapPath,
        minProfit
      );

      // Verify profit tracking
      const totalProfits = await flashLoanArbitrage.totalProfits();
      expect(totalProfits).to.be.gt(0);
    });

    it('should emit correct profit in ArbitrageExecuted event', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.000505')
      );

      const flashLoanAmount = ethers.parseEther('10');

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

      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          0
        )
      )
        .to.emit(flashLoanArbitrage, 'ArbitrageExecuted')
        .withArgs(
          await weth.getAddress(),
          flashLoanAmount,
          expect.anything(), // profit amount
          expect.anything() // timestamp
        );
    });
  });

  // ===========================================================================
  // Fund Recovery Tests
  // ===========================================================================
  describe('Fund Recovery', () => {
    it('should correctly repay flash loan with premium', async () => {
      const { flashLoanArbitrage, aavePool, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.000505')
      );

      const flashLoanAmount = ethers.parseEther('10');
      const poolBalanceBefore = await weth.balanceOf(await aavePool.getAddress());

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

      await flashLoanArbitrage.executeArbitrage(
        await weth.getAddress(),
        flashLoanAmount,
        swapPath,
        0
      );

      const poolBalanceAfter = await weth.balanceOf(await aavePool.getAddress());

      // Pool should have received back the loan + premium (0.09%)
      const premium = (flashLoanAmount * 9n) / 10000n;
      expect(poolBalanceAfter).to.be.gte(poolBalanceBefore + premium);
    });

    it('should allow owner to withdraw stuck tokens', async () => {
      const { flashLoanArbitrage, weth, owner } = await loadFixture(deployContractsFixture);

      // Simulate some tokens stuck in contract
      await weth.mint(await flashLoanArbitrage.getAddress(), ethers.parseEther('1'));

      const ownerBalanceBefore = await weth.balanceOf(owner.address);

      await flashLoanArbitrage.withdrawToken(
        await weth.getAddress(),
        owner.address,
        ethers.parseEther('1')
      );

      const ownerBalanceAfter = await weth.balanceOf(owner.address);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther('1'));
    });

    it('should allow owner to withdraw ETH', async () => {
      const { flashLoanArbitrage, owner } = await loadFixture(deployContractsFixture);

      // Send some ETH to contract
      await owner.sendTransaction({
        to: await flashLoanArbitrage.getAddress(),
        value: ethers.parseEther('1'),
      });

      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

      const tx = await flashLoanArbitrage.withdrawETH(owner.address, ethers.parseEther('1'));
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
      expect(ownerBalanceAfter).to.be.closeTo(
        ownerBalanceBefore + ethers.parseEther('1') - gasUsed,
        ethers.parseEther('0.01') // Allow for gas variance
      );
    });
  });

  // ===========================================================================
  // Security Tests
  // ===========================================================================
  describe('Security', () => {
    it('should prevent reentrancy attacks', async () => {
      const { flashLoanArbitrage, dexRouter1, weth, usdc } =
        await loadFixture(deployContractsFixture);

      // Deploy malicious router that tries reentrancy
      const MaliciousRouterFactory = await ethers.getContractFactory('MockMaliciousRouter');
      const maliciousRouter = await MaliciousRouterFactory.deploy(
        await flashLoanArbitrage.getAddress()
      );

      await flashLoanArbitrage.addApprovedRouter(await maliciousRouter.getAddress());

      // Fund the malicious router
      await weth.mint(await maliciousRouter.getAddress(), ethers.parseEther('100'));
      await usdc.mint(await maliciousRouter.getAddress(), ethers.parseUnits('100000', 6));

      const swapPath = [
        {
          router: await maliciousRouter.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 0,
        },
      ];

      // Reentrancy attempt should fail
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0
        )
      ).to.be.reverted;
    });

    it('should validate flash loan initiator', async () => {
      const { flashLoanArbitrage, aavePool, weth, attacker } =
        await loadFixture(deployContractsFixture);

      // Try to call executeOperation directly (simulate attack)
      // Only the Aave pool should be able to call this
      await expect(
        flashLoanArbitrage.executeOperation(
          await weth.getAddress(),
          ethers.parseEther('10'),
          ethers.parseEther('0.009'),
          attacker.address,
          '0x'
        )
      ).to.be.revertedWith('Invalid flash loan initiator');
    });

    it('should validate flash loan caller', async () => {
      const { flashLoanArbitrage, weth, attacker } = await loadFixture(deployContractsFixture);

      // Try to call executeOperation from non-pool address
      await expect(
        flashLoanArbitrage
          .connect(attacker)
          .executeOperation(
            await weth.getAddress(),
            ethers.parseEther('10'),
            ethers.parseEther('0.009'),
            await flashLoanArbitrage.getAddress(),
            '0x'
          )
      ).to.be.revertedWith('Invalid flash loan caller');
    });
  });

  // ===========================================================================
  // Gas Optimization Tests
  // ===========================================================================
  describe('Gas Optimization', () => {
    it('should execute arbitrage within gas budget', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.000505')
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

      const tx = await flashLoanArbitrage.executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0
      );

      const receipt = await tx.wait();

      // Gas should be reasonable for 2-hop arbitrage
      // Target: < 500,000 gas for 2-hop swap
      expect(receipt!.gasUsed).to.be.lt(500000);
    });
  });
});
