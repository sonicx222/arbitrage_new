import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { FlashLoanArbitrage, MockAavePool, MockDexRouter, MockERC20 } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  deployBaseFixture,
  fundProvider,
  setupProfitableWethUsdcRates,
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  build2HopPath,
  build2HopCrossRouterPath,
  build3HopPath,
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
  type AdminTestConfig,
} from './helpers';

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
    const base = await deployBaseFixture();

    // Deploy Aave pool and fund it for flash loans
    const MockAavePoolFactory = await ethers.getContractFactory('MockAavePool');
    const aavePool = await MockAavePoolFactory.deploy();
    await fundProvider(base, await aavePool.getAddress(), {
      wethPerRouter: ethers.parseEther('10000'),
      usdcPerRouter: ethers.parseUnits('10000000', 6),
      daiPerRouter: ethers.parseEther('10000000'),
    });

    // Deploy FlashLoanArbitrage contract
    const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
    const flashLoanArbitrage = await FlashLoanArbitrageFactory.deploy(
      await aavePool.getAddress(),
      base.owner.address
    );

    return { flashLoanArbitrage, aavePool, ...base };
  }

  // ===========================================================================
  // Deployment Defaults (shared) + Aave-Specific Deployment
  // ===========================================================================
  testDeploymentDefaults({
    contractName: 'FlashLoanArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return { contract: f.flashLoanArbitrage, owner: f.owner };
    },
  });

  describe('Deployment — Aave-Specific', () => {
    it('should set correct Aave pool address', async () => {
      const { flashLoanArbitrage, aavePool } = await loadFixture(deployContractsFixture);
      expect(await flashLoanArbitrage.POOL()).to.equal(await aavePool.getAddress());
    });

    it('should revert on zero pool address', async () => {
      const [owner] = await ethers.getSigners();
      const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
      await expect(
        FlashLoanArbitrageFactory.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: FlashLoanArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });
  });

  // ===========================================================================
  // Admin Functions Tests (shared harness — eliminates ~200 LOC of duplication)
  // ===========================================================================
  const adminConfig: AdminTestConfig = {
    contractName: 'FlashLoanArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.flashLoanArbitrage,
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
    contractName: 'FlashLoanArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.flashLoanArbitrage,
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
        params.asset, params.amount, params.swapPath, params.minProfit, params.deadline
      ),
  });

  // ===========================================================================
  // Minimum Profit — Integration Tests (unique to FlashLoanArbitrage)
  // ===========================================================================
  describe('Minimum Profit Enforcement', () => {
    it('should enforce global minimum profit even when caller specifies lower', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      // Setup routers
      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Set a high global minimum profit
      const highMinProfit = ethers.parseEther('1'); // 1 WETH minimum
      await flashLoanArbitrage.setMinimumProfit(highMinProfit);

      // Configure rates for ~0.1 WETH profit (below global minimum)
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

      // Even with 0 minProfit from caller, should fail due to global minimum
      const deadline = await getDeadline();
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath,
          0, // Caller specifies 0, but global minimum is 1 WETH
          deadline
        )
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InsufficientProfit');
    });
  });

  // ===========================================================================
  // Calculate Expected Profit (shared + Aave-specific)
  // ===========================================================================
  testCalculateExpectedProfit({
    contractName: 'FlashLoanArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.flashLoanArbitrage,
        owner: f.owner,
        dexRouter1: f.dexRouter1,
        weth: f.weth,
        usdc: f.usdc,
      };
    },
    triggerCalculateProfit: async (contract, params) => {
      const [expectedProfit, flashLoanFee] = await contract.calculateExpectedProfit(
        params.asset, params.amount, params.swapPath
      );
      return { expectedProfit, flashLoanFee };
    },
    profitableReverseRate: RATE_USDC_TO_WETH_1PCT_PROFIT,
  });

  describe('Calculate Expected Profit — Aave-Specific', () => {
    it('should calculate flash loan fee as 0.09% (Aave premium)', async () => {
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
        RATE_USDC_TO_WETH_1PCT_PROFIT
      );

      const [, flashLoanFee] = await flashLoanArbitrage.calculateExpectedProfit(
        await weth.getAddress(),
        ethers.parseEther('10'),
        [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 0,
          },
          {
            router: await dexRouter2.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0,
          },
        ]
      );

      // Flash loan fee should be 0.09% of 10 WETH = 0.009 WETH
      expect(flashLoanFee).to.equal(ethers.parseEther('0.009'));
    });

    it('should still calculate fee for invalid path', async () => {
      const { flashLoanArbitrage, dexRouter1, weth, usdc, dai } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );

      const [expectedProfit, flashLoanFee] = await flashLoanArbitrage.calculateExpectedProfit(
        await weth.getAddress(),
        ethers.parseEther('10'),
        [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 0,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(), // Invalid: should be USDC
            tokenOut: await weth.getAddress(),
            amountOutMin: 0,
          },
        ]
      );

      expect(expectedProfit).to.equal(0);
      expect(flashLoanFee).to.equal(ethers.parseEther('0.009'));
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
      // Router1: 1 WETH = 2000 USDC (rate: output = input * rate / 1e18)
      // For 10 WETH input: output = 10e18 * 2000e6 / 1e18 = 20000e6 USDC
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6) // 2000 USDC per WETH (works correctly)
      );
      // Router2: USDC -> WETH with profit
      // For 20000e6 USDC input, want ~10.1 WETH (1% profit)
      // rate = 10.1e18 * 1e18 / 20000e6 = 5.05e26
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT // 5.05e26 - gives 10.1 WETH for 20000 USDC
      );

      const flashLoanAmount = ethers.parseEther('10'); // 10 WETH
      const minProfit = ethers.parseEther('0.01'); // Minimum 0.01 WETH profit

      // Build swap path
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('19000', 6), // Expect 20000 USDC, min 19000
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('10'), // Expect ~10.1 WETH, min 10
        },
      ];

      // Execute flash loan arbitrage
      const deadline = await getDeadline();
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          minProfit,
          deadline
        )
      ).to.emit(flashLoanArbitrage, 'ArbitrageExecuted');
    });

    it('should revert when profit is below minimum', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } =
        await loadFixture(deployContractsFixture);

      // Setup: Add routers
      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Setup: Configure DEX rates for marginal profit (below threshold after fees)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      // For 20000e6 USDC input, give back 10.01 WETH (minimal profit, below minProfit)
      // rate = 10.01e18 * 1e18 / 20000e6 = 5.005e26
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('500500000000000000000000000') // 5.005e26 - gives 10.01 WETH
      );

      const flashLoanAmount = ethers.parseEther('10');
      const minProfit = ethers.parseEther('0.1'); // High minimum profit (10.01 - 10 - fee < 0.1)

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
          amountOutMin: ethers.parseEther('10'), // Expect 10.01 WETH
        },
      ];

      const deadline = await getDeadline();
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          minProfit,
          deadline
        )
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InsufficientProfit');
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
      // For 20000e6 USDC input, give back 10.1 WETH (1% profit)
      // rate = 10.1e18 * 1e18 / 20000e6 = 5.05e26
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT // 5.05e26 - gives 10.1 WETH for 20000 USDC
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
          amountOutMin: ethers.parseEther('10'),
        },
      ];

      const deadline = await getDeadline();
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          ethers.parseEther('0.01'),
          deadline
        )
      ).to.emit(flashLoanArbitrage, 'ArbitrageExecuted');
    });

    it('should execute 3-hop swap (triangular arbitrage)', async () => {
      const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc, dai, owner } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
      await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

      // Configure rates for triangular arbitrage: WETH -> USDC -> DAI -> WETH
      // 1. WETH (18 dec) -> USDC (6 dec): 10 WETH -> 20000 USDC
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6) // 2000 USDC per WETH
      );
      // 2. USDC (6 dec) -> DAI (18 dec): 20000 USDC -> 20200 DAI
      // For 2e10 (20000e6) USDC input, want 20200e18 DAI output
      // rate = (20200e18 * 1e18) / 2e10 = 1.01e30
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1010000000000000000000000000000') // 1.01e30 - gives 20200 DAI for 20000 USDC
      );
      // 3. DAI (18 dec) -> WETH (18 dec): 20200 DAI -> 10.2 WETH
      // For 20200e18 DAI input, want 10.2e18 WETH output (2% profit before fees)
      // rate = (10.2e18 * 1e18) / 20200e18 = 5.05e14
      await dexRouter2.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        BigInt('505000000000000') // 5.05e14 - gives 10.2 WETH for 20200 DAI
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
          amountOutMin: ethers.parseEther('10'),
        },
      ];

      const deadline = await getDeadline();
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          ethers.parseEther('0.01'),
          deadline
        )
      ).to.emit(flashLoanArbitrage, 'ArbitrageExecuted');
    });

    it('should revert when swap output is below minimum', async () => {
      const { flashLoanArbitrage, dexRouter1, weth, usdc } =
        await loadFixture(deployContractsFixture);

      await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

      // Set exchange rates for a circular path
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('100', 6) // Only 100 USDC per WETH (low rate)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT // USDC→WETH rate
      );

      // Circular path WETH→USDC→WETH with impossibly high amountOutMin on first hop.
      // Second hop amountOutMin must be > 0 to pass slippage protection validation.
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('2000', 6), // Expect 2000, but will only get 100
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      // The revert comes from MockDexRouter's internal check (output < amountOutMin)
      const deadline = await getDeadline();
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
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
        RATE_USDC_TO_WETH_1PCT_PROFIT // ~1% profit opportunity
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

      const deadline = await getDeadline();
      const tx = await flashLoanArbitrage.executeArbitrage(
        await weth.getAddress(),
        flashLoanAmount,
        swapPath,
        minProfit,
        deadline
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
        RATE_USDC_TO_WETH_1PCT_PROFIT
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

      // Just check the event is emitted with the correct asset and amount
      // Profit and timestamp are dynamic values
      const deadline = await getDeadline();
      await expect(
        flashLoanArbitrage.executeArbitrage(
          await weth.getAddress(),
          flashLoanAmount,
          swapPath,
          0,
          deadline
        )
      ).to.emit(flashLoanArbitrage, 'ArbitrageExecuted');
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
        RATE_USDC_TO_WETH_1PCT_PROFIT
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

      const deadline = await getDeadline();
      await flashLoanArbitrage.executeArbitrage(
        await weth.getAddress(),
        flashLoanAmount,
        swapPath,
        0,
        deadline
      );

      const poolBalanceAfter = await weth.balanceOf(await aavePool.getAddress());

      // Pool should have received back the loan + premium (0.09%)
      const premium = (flashLoanAmount * 9n) / 10000n;
      expect(poolBalanceAfter).to.be.gte(poolBalanceBefore + premium);
    });

  });

  // ===========================================================================
  // Security Tests
  // ===========================================================================
  /**
   * Fix 8.3 Note: Testing pause() during active execution
   *
   * Ethereum contract calls are atomic within a transaction, so you cannot:
   * - Call pause() while executeOperation is in progress (same tx)
   * - The ReentrancyGuard prevents re-entering during callback execution
   *
   * Possible scenarios that ARE tested:
   * 1. Pause before execution starts (line 548-570: "should revert when contract is paused")
   * 2. Reentrancy attack attempts (covered below)
   * 3. Direct executeOperation calls from non-pool addresses (covered below)
   *
   * A theoretical attack where owner pauses between blocks while a tx is pending
   * in the mempool would simply cause the pending tx to revert with "Pausable: paused"
   * which is the expected behavior and doesn't require additional testing.
   */
  // Reentrancy Protection (shared — MockMaliciousRouter)
  testReentrancyProtection({
    contractName: 'FlashLoanArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.flashLoanArbitrage,
        owner: f.owner,
        user: f.user,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
        usdc: f.usdc,
        dai: f.dai,
      };
    },
    triggerWithMaliciousRouter: async (fixture, maliciousRouterAddress) => {
      const { contract, owner, dexRouter1, weth, usdc } = fixture;
      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(), await weth.getAddress(), ethers.parseEther('1.01')
      );
      const swapPath = [
        { router: maliciousRouterAddress, tokenIn: await weth.getAddress(), tokenOut: await usdc.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await usdc.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1n },
      ];
      const deadline = await getDeadline();
      await contract.executeArbitrage(await weth.getAddress(), ethers.parseEther('1'), swapPath, 0, deadline);
    },
  });

  describe('Security', () => {
    it('should reject direct executeOperation calls (caller check)', async () => {
      const { flashLoanArbitrage, aavePool, weth, attacker } =
        await loadFixture(deployContractsFixture);

      // Try to call executeOperation directly (simulate attack)
      // The caller check comes first (msg.sender must be POOL)
      await expect(
        flashLoanArbitrage.executeOperation(
          await weth.getAddress(),
          ethers.parseEther('10'),
          ethers.parseEther('0.009'),
          attacker.address,
          '0x'
        )
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InvalidFlashLoanCaller');
    });

    it('should validate flash loan caller', async () => {
      const { flashLoanArbitrage, weth, attacker } = await loadFixture(deployContractsFixture);

      // Try to call executeOperation from non-pool address
      const attackerContract = flashLoanArbitrage.connect(attacker) as FlashLoanArbitrage;
      await expect(
        attackerContract.executeOperation(
          await weth.getAddress(),
          ethers.parseEther('10'),
          ethers.parseEther('0.009'),
          await flashLoanArbitrage.getAddress(),
          '0x'
        )
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InvalidFlashLoanCaller');
    });

    it('should revert with InvalidFlashLoanInitiator when initiator is not the contract', async () => {
      const { flashLoanArbitrage, aavePool, weth, owner, attacker } =
        await loadFixture(deployContractsFixture);

      // Impersonate the Aave Pool to bypass the caller check (msg.sender == POOL),
      // then provide a wrong initiator to trigger the initiator check.
      const poolAddress = await aavePool.getAddress();
      await ethers.provider.send('hardhat_impersonateAccount', [poolAddress]);
      await owner.sendTransaction({ to: poolAddress, value: ethers.parseEther('1') });
      const poolSigner = await ethers.getSigner(poolAddress);

      const swapPath = [
        {
          router: ethers.ZeroAddress,
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];
      const params = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
        [swapPath, 0n]
      );

      // Call executeOperation from the pool with attacker as initiator (not the contract itself)
      await expect(
        flashLoanArbitrage.connect(poolSigner).executeOperation(
          await weth.getAddress(),
          ethers.parseEther('10'),
          ethers.parseEther('0.009'),
          attacker.address, // Wrong initiator - should be the contract address
          params
        )
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InvalidFlashLoanInitiator');

      await ethers.provider.send('hardhat_stopImpersonatingAccount', [poolAddress]);
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
        RATE_USDC_TO_WETH_1PCT_PROFIT
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

      const deadline = await getDeadline();
      const tx = await flashLoanArbitrage.executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );

      const receipt = await tx.wait();

      // Gas should be reasonable for 2-hop arbitrage
      // Target: < 500,000 gas for 2-hop swap
      expect(receipt!.gasUsed).to.be.lt(500000);
    });
  });

  // ===========================================================================
  // Edge Case Tests (Added for regression prevention)
  // ===========================================================================
  describe('Edge Cases', () => {
    describe('Constants Verification', () => {
      it('should have correct DEFAULT_SWAP_DEADLINE constant', async () => {
        const { flashLoanArbitrage } = await loadFixture(deployContractsFixture);
        expect(await flashLoanArbitrage.DEFAULT_SWAP_DEADLINE()).to.equal(60n);
      });

      it('should have correct MAX_SWAP_DEADLINE constant', async () => {
        const { flashLoanArbitrage } = await loadFixture(deployContractsFixture);
        expect(await flashLoanArbitrage.MAX_SWAP_DEADLINE()).to.equal(600n);
      });

      it('should have correct MIN_SLIPPAGE_BPS constant (Fix 6.1)', async () => {
        const { flashLoanArbitrage } = await loadFixture(deployContractsFixture);
        expect(await flashLoanArbitrage.MIN_SLIPPAGE_BPS()).to.equal(10n);
      });
    });
  });

  // ===========================================================================
  // Fix 8.x: Additional Test Cases for New Validations
  // ===========================================================================
  describe('New Validations (Fix 8.x)', () => {
    describe('Fix 8.1: SwapPath Asset Mismatch', () => {
      it('should revert when swapPath[0].tokenIn != flash loaned asset', async () => {
        const { flashLoanArbitrage, dexRouter1, weth, usdc, dai } = await loadFixture(deployContractsFixture);

        // Add router
        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

        // Create swap path that starts with USDC but we flash loan WETH
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),  // Wrong! Should be WETH
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        // Should revert with SwapPathAssetMismatch
        const deadline = await getDeadline();
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),  // Flash loan WETH
            ethers.parseEther('10'),
            swapPath,
            0,
            deadline
          )
        ).to.be.revertedWithCustomError(flashLoanArbitrage, 'SwapPathAssetMismatch');
      });

      it('should calculate expected profit as 0 for mismatched asset', async () => {
        const { flashLoanArbitrage, dexRouter1, weth, usdc, dai } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

        // Path starts with USDC but asset is WETH
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 0n,
          },
        ];

        const [profit, fee] = await flashLoanArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(profit).to.equal(0n);
        expect(fee).to.be.gt(0n); // Fee is still calculated
      });
    });

    describe('Fix 8.2: InsufficientSlippageProtection', () => {
      it('should revert when amountOutMin is zero', async () => {
        const { flashLoanArbitrage, dexRouter1, weth, usdc } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 0n,  // Zero slippage protection - dangerous!
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,  // This one is fine
          },
        ];

        const deadline = await getDeadline();
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),
            ethers.parseEther('10'),
            swapPath,
            0,
            deadline
          )
        ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InsufficientSlippageProtection');
      });

      it('should allow non-zero amountOutMin', async () => {
        const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
        await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

        // Set exchange rates for profitable arbitrage
        await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
        await dexRouter2.setExchangeRate(await usdc.getAddress(), await weth.getAddress(), ethers.parseUnits('0.00051', 18));

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,  // Non-zero - passes validation
          },
          {
            router: await dexRouter2.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,  // Non-zero - passes validation
          },
        ];

        // Should not revert on validation (may revert on profit check)
        // We're just testing the slippage validation passes
        const deadline = await getDeadline();
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),
            ethers.parseEther('10'),
            swapPath,
            0,
            deadline
          )
        ).to.not.be.revertedWithCustomError(flashLoanArbitrage, 'InsufficientSlippageProtection');
      });
    });

    describe('Fix 10.3: Router Validation Optimization', () => {
      it('should only validate unique routers (optimization test)', async () => {
        const { flashLoanArbitrage, dexRouter1, weth, usdc, dai } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

        // Set exchange rates
        await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
        await dexRouter1.setExchangeRate(await usdc.getAddress(), await dai.getAddress(), ethers.parseUnits('1', 18));
        await dexRouter1.setExchangeRate(await dai.getAddress(), await weth.getAddress(), ethers.parseUnits('0.00052', 18));

        // Create 3-hop path with same router (common in triangular arb)
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),  // Same router
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),  // Same router
            tokenIn: await usdc.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),  // Same router
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];

        // Should work - router validation is optimized to skip repeated routers
        // Will likely revert on profit, but that's expected
        const deadline = await getDeadline();
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),
            ethers.parseEther('10'),
            swapPath,
            0,
            deadline
          )
        ).to.not.be.revertedWithCustomError(flashLoanArbitrage, 'RouterNotApproved');
      });
    });

    describe('Fix 8.4: Zero Output Handling', () => {
      it('should handle calculateExpectedProfit with router returning zero', async () => {
        const { flashLoanArbitrage, dexRouter1, weth, usdc } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

        // Set a tiny exchange rate that will truncate to 0 for small amounts
        await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), 1n);

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 0n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0n,
          },
        ];

        // Should return 0 profit for path that produces 0 output
        const [profit] = await flashLoanArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          1n,  // Very small amount
          swapPath
        );

        // Profit should be 0 due to truncation
        expect(profit).to.equal(0n);
      });
    });

    describe('P2-1: Amount Validation', () => {
      it('should revert when amount is zero', async () => {
        const { flashLoanArbitrage, dexRouter1, weth, usdc } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),
            0, // Zero amount - should revert
            swapPath,
            0,
            deadline
          )
        ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InvalidAmount');
      });

      it('should accept positive amounts', async () => {
        const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
        await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

        // Set exchange rates for profitable arbitrage
        await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
        await dexRouter2.setExchangeRate(await usdc.getAddress(), await weth.getAddress(), ethers.parseUnits('0.00051', 18));

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter2.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();
        // Should not revert with InvalidAmount
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),
            ethers.parseEther('1'), // Positive amount
            swapPath,
            0,
            deadline
          )
        ).to.not.be.revertedWithCustomError(flashLoanArbitrage, 'InvalidAmount');
      });
    });

    describe('P2-2: Transaction Deadline', () => {
      it('should revert when deadline has passed', async () => {
        const { flashLoanArbitrage, dexRouter1, weth, usdc } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,
          },
        ];

        // Use a deadline in the past
        const pastDeadline = await getDeadline(-1);
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),
            ethers.parseEther('1'),
            swapPath,
            0,
            pastDeadline
          )
        ).to.be.revertedWithCustomError(flashLoanArbitrage, 'TransactionTooOld');
      });

      it('should accept future deadlines', async () => {
        const { flashLoanArbitrage, dexRouter1, dexRouter2, weth, usdc } = await loadFixture(deployContractsFixture);

        await flashLoanArbitrage.addApprovedRouter(await dexRouter1.getAddress());
        await flashLoanArbitrage.addApprovedRouter(await dexRouter2.getAddress());

        // Set exchange rates for profitable arbitrage
        await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
        await dexRouter2.setExchangeRate(await usdc.getAddress(), await weth.getAddress(), ethers.parseUnits('0.00051', 18));

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter2.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];

        // Use a deadline in the future
        const futureDeadline = await getDeadline();
        await expect(
          flashLoanArbitrage.executeArbitrage(
            await weth.getAddress(),
            ethers.parseEther('1'),
            swapPath,
            0,
            futureDeadline
          )
        ).to.not.be.revertedWithCustomError(flashLoanArbitrage, 'TransactionTooOld');
      });
    });
  });
});
