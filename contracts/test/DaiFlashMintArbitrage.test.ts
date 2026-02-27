import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import {
  DaiFlashMintArbitrage,
  MockDexRouter,
  MockERC20,
  MockDssFlash,
} from '../typechain-types';
import {
  deployBaseFixture,
  fundProvider,
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
  testReentrancyProtection,
  build2HopPath,
  build2HopCrossRouterPath,
} from './helpers';

/**
 * DaiFlashMintArbitrage Contract Tests
 *
 * Test suite for DAI Flash Mint arbitrage using MakerDAO's DssFlash module (EIP-3156).
 *
 * Contract implements EIP-3156 compliant flash mint arbitrage:
 * 1. Flash mint DAI from DssFlash (1 bps / 0.01% fee)
 * 2. Multi-hop swap execution across approved DEX routers
 * 3. Profit verification and tracking
 * 4. Router whitelist management
 * 5. Emergency controls (pause/unpause)
 *
 * @see contracts/src/DaiFlashMintArbitrage.sol
 */
describe('DaiFlashMintArbitrage', () => {
  // ==========================================================================
  // Test Fixture
  // ==========================================================================
  async function deployContractsFixture() {
    const base = await deployBaseFixture();

    // Deploy MockDssFlash with 1 bps fee (0.01%)
    const MockDssFlashFactory = await ethers.getContractFactory('MockDssFlash');
    const dssFlash = await MockDssFlashFactory.deploy(1); // 1 bps fee

    // Fund DssFlash with DAI so it can issue flash loans
    await fundProvider(base, await dssFlash.getAddress());

    // Deploy DaiFlashMintArbitrage contract
    const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
      'DaiFlashMintArbitrage'
    );
    const daiArbitrage = await DaiFlashMintArbitrageFactory.deploy(
      await dssFlash.getAddress(),
      await base.dai.getAddress(),
      base.owner.address
    );

    return { daiArbitrage, dssFlash, ...base };
  }

  // Admin test config for shared harness
  const adminConfig = {
    contractName: 'DaiFlashMintArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.daiArbitrage,
        owner: f.owner,
        user: f.user,
        attacker: f.attacker,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
      };
    },
  };

  // ==========================================================================
  // 1. Deployment and Initialization Tests
  // ==========================================================================
  testDeploymentDefaults({
    contractName: 'DaiFlashMintArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return { contract: f.daiArbitrage, owner: f.owner };
    },
  });

  describe('1. DaiFlashMint-Specific Deployment', () => {
    it('should set DSS_FLASH address correctly', async () => {
      const { daiArbitrage, dssFlash } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.DSS_FLASH()).to.equal(await dssFlash.getAddress());
    });

    it('should set DAI address correctly', async () => {
      const { daiArbitrage, dai } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.DAI()).to.equal(await dai.getAddress());
    });

    it('should revert on zero address dssFlash', async () => {
      const [owner] = await ethers.getSigners();
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const dai = await MockERC20Factory.deploy('DAI', 'DAI', 18);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          ethers.ZeroAddress,
          await dai.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should revert on non-contract dssFlash address (EOA)', async () => {
      const [owner, user] = await ethers.getSigners();
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const dai = await MockERC20Factory.deploy('DAI', 'DAI', 18);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          user.address,
          await dai.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should revert on zero address DAI', async () => {
      const [owner] = await ethers.getSigners();
      const MockDssFlashFactory = await ethers.getContractFactory('MockDssFlash');
      const dssFlash = await MockDssFlashFactory.deploy(1);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          await dssFlash.getAddress(),
          ethers.ZeroAddress,
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidDaiAddress'
      );
    });

    it('should revert on non-contract DAI address (EOA)', async () => {
      const [owner, user] = await ethers.getSigners();
      const MockDssFlashFactory = await ethers.getContractFactory('MockDssFlash');
      const dssFlash = await MockDssFlashFactory.deploy(1);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          await dssFlash.getAddress(),
          user.address,
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidDaiAddress'
      );
    });
  });

  // ==========================================================================
  // 2. Router Management Tests (shared harness)
  // ==========================================================================
  testRouterManagement(adminConfig);

  // ==========================================================================
  // 3. Input Validation Tests (shared harness)
  // ==========================================================================
  testInputValidation({
    contractName: 'DaiFlashMintArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.daiArbitrage,
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
        params.amount, params.swapPath, params.minProfit, params.deadline
      ),
    getAssetAddress: async (f) => f.dai.getAddress(),
  });

  // ==========================================================================
  // 3b. Flash Loan Execution Tests
  // ==========================================================================
  describe('3b. Flash Loan Execution', () => {
    describe('executeArbitrage()', () => {
      it('should execute successful arbitrage with profit', async () => {
        const {
          daiArbitrage,
          dssFlash,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        // Setup: Add router and configure profitable rates
        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure rates for profitable arbitrage
        // DAI -> WETH: 1 DAI = 0.0005 WETH (2000 DAI per WETH)
        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005') // 0.0005 WETH per DAI
        );
        // WETH -> DAI: 1 WETH = 2100 DAI (profitable return: ~5% profit)
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100') // 2100 DAI per WETH
        );

        const amountIn = ethers.parseEther('10000'); // 10000 DAI
        const swapPath = build2HopPath(await dexRouter1.getAddress(), await dai.getAddress(), await weth.getAddress(), 1n, 1n);
        const deadline = await getDeadline();

        // Execute arbitrage (note: no asset param, always DAI)
        await daiArbitrage
          .connect(user)
          .executeArbitrage(amountIn, swapPath, 0n, deadline);

        // Verify profit was recorded
        expect(await daiArbitrage.totalProfits()).to.be.gt(0);
      });

      it('should emit ArbitrageExecuted event', async () => {
        const {
          daiArbitrage,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure profitable rates
        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100')
        );

        const amountIn = ethers.parseEther('10000');
        const swapPath = build2HopPath(await dexRouter1.getAddress(), await dai.getAddress(), await weth.getAddress(), 1n, 1n);
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.emit(daiArbitrage, 'ArbitrageExecuted');
      });

      it('should track per-token profit correctly', async () => {
        const {
          daiArbitrage,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100')
        );

        const amountIn = ethers.parseEther('10000');
        const swapPath = build2HopPath(await dexRouter1.getAddress(), await dai.getAddress(), await weth.getAddress(), 1n, 1n);
        const deadline = await getDeadline();
        await daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline);

        // Verify DAI-specific profit tracking
        const daiProfit = await daiArbitrage.tokenProfits(await dai.getAddress());
        expect(daiProfit).to.be.gt(0);
      });

      it('should revert on insufficient profit', async () => {
        const {
          daiArbitrage,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure rates with very small profit (less than minimumProfit of 1e14)
        // DAI -> WETH: 0.0005 WETH per DAI
        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        // WETH -> DAI: 2000.02 DAI per WETH (barely covers fee, very small profit)
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2000.02')
        );

        const amountIn = ethers.parseEther('100'); // 100 DAI
        const swapPath = build2HopPath(await dexRouter1.getAddress(), await dai.getAddress(), await weth.getAddress(), 1n, 1n);
        const deadline = await getDeadline();

        // Profit is ~0.01 DAI = 1e16 wei, but minProfit set very high
        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, ethers.parseEther('1000'), deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InsufficientProfit');
      });

      it('should revert if flash loan fails', async () => {
        const {
          daiArbitrage,
          dssFlash,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Set DssFlash to fail flash loans
        await dssFlash.setShouldFailFlashLoan(true);

        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100')
        );

        const amountIn = ethers.parseEther('1000');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'FlashLoanFailed');
      });
    });

    describe('onFlashLoan() callback', () => {
      it('should revert if caller is not DssFlash', async () => {
        const { daiArbitrage, dai, attacker } = await loadFixture(
          deployContractsFixture
        );

        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await dai.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
          [swapPath, 0n]
        );

        await expect(
          daiArbitrage
            .connect(attacker)
            .onFlashLoan(attacker.address, await dai.getAddress(), ethers.parseEther('1'), 0, data)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidFlashLoanCaller');
      });

      it('should revert with InvalidFlashLoanInitiator when initiator is not the contract', async () => {
        const { daiArbitrage, dssFlash, dai, owner, attacker } = await loadFixture(
          deployContractsFixture
        );

        // Impersonate the DssFlash to bypass the caller check (msg.sender == DSS_FLASH),
        // then provide a wrong initiator to trigger the initiator check.
        const dssFlashAddress = await dssFlash.getAddress();
        await ethers.provider.send('hardhat_impersonateAccount', [dssFlashAddress]);
        await owner.sendTransaction({ to: dssFlashAddress, value: ethers.parseEther('1') });
        const dssFlashSigner = await ethers.getSigner(dssFlashAddress);

        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await dai.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
          [swapPath, 0n]
        );

        // Call onFlashLoan from the DssFlash with attacker as initiator (not the contract itself)
        await expect(
          daiArbitrage.connect(dssFlashSigner).onFlashLoan(
            attacker.address, // Wrong initiator - should be the contract address
            await dai.getAddress(),
            ethers.parseEther('1'),
            0,
            data
          )
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidFlashLoanInitiator');

        await ethers.provider.send('hardhat_stopImpersonatingAccount', [dssFlashAddress]);
      });
    });
  });

  // Reentrancy Protection (shared — MockMaliciousRouter)
  testReentrancyProtection({
    contractName: 'DaiFlashMintArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.daiArbitrage,
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
      const { contract, owner, dexRouter1, weth, dai } = fixture;
      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      // DAI→WETH (malicious, 1:1) → WETH→DAI (normal, profit)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(), await dai.getAddress(), ethers.parseEther('2100')
      );
      const swapPath = [
        { router: maliciousRouterAddress, tokenIn: await dai.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await weth.getAddress(), tokenOut: await dai.getAddress(), amountOutMin: 1n },
      ];
      const deadline = await getDeadline();
      await contract.connect(fixture.user).executeArbitrage(ethers.parseEther('100'), swapPath, 0n, deadline);
    },
  });

  // ==========================================================================
  // 4. Pause Functionality Tests (shared harness)
  // ==========================================================================
  testPauseUnpause(adminConfig);

  // ==========================================================================
  // 5. Owner-Only Admin Functions Tests (shared harness)
  // ==========================================================================
  testMinimumProfitConfig(adminConfig);
  testSwapDeadlineConfig(adminConfig);
  testWithdrawToken(adminConfig);
  testWithdrawETH(adminConfig);
  testWithdrawGasLimitConfig(adminConfig);
  testOwnable2Step(adminConfig);

  // ==========================================================================
  // 6. Calculate Expected Profit Tests
  // ==========================================================================
  describe('6. Calculate Expected Profit', () => {
    it('should calculate expected profit correctly', async () => {
      const {
        daiArbitrage,
        dssFlash,
        dexRouter1,
        dai,
        weth,
        owner,
      } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure profitable rates
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005')
      );
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await dai.getAddress(),
        ethers.parseEther('2100')
      );

      const amount = ethers.parseEther('10000');
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await dai.getAddress(), await weth.getAddress(), 1n, 1n);

      const [expectedProfit, flashLoanFee] = await daiArbitrage.calculateExpectedProfit(
        amount,
        swapPath
      );

      // Flash loan fee: 10000 * 1 / 10000 = 1 DAI
      expect(flashLoanFee).to.equal(ethers.parseEther('1'));
      // Expected profit should be positive
      expect(expectedProfit).to.be.gt(0);
    });

    it('should return zero profit for unprofitable path', async () => {
      const {
        daiArbitrage,
        dexRouter1,
        dai,
        weth,
        owner,
      } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure unprofitable rates (round-trip loses money)
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005')
      );
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await dai.getAddress(),
        ethers.parseEther('1900') // Only 1900 DAI back instead of 2000+
      );

      const amount = ethers.parseEther('10000');
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await dai.getAddress(), await weth.getAddress(), 1n, 1n);

      const [expectedProfit] = await daiArbitrage.calculateExpectedProfit(amount, swapPath);

      expect(expectedProfit).to.equal(0);
    });
  });

  // ==========================================================================
  // 7. Multi-hop Swap Execution
  // ==========================================================================
  describe('7. Multi-hop Swap Execution', () => {
    it('should execute 3-hop triangular arbitrage (DAI -> WETH -> USDC -> DAI)', async () => {
      const {
        daiArbitrage,
        dexRouter1,
        dexRouter2,
        dai,
        weth,
        usdc,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      // Configure triangular rates: DAI -> WETH -> USDC -> DAI
      // Leg 1: DAI -> WETH on router1 (1 DAI = 0.0005 WETH)
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005')
      );
      // Leg 2: WETH -> USDC on router1 (1 WETH = 2000 USDC)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      // Leg 3: USDC -> DAI on router2 (1 USDC = 1.06 DAI — profitable)
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1060000000000000000000000000000') // 1.06 DAI per USDC adjusted for 6->18 decimals
      );

      const amountIn = ethers.parseEther('10000'); // 10000 DAI
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
      ).to.emit(daiArbitrage, 'ArbitrageExecuted');

      // Verify profit was recorded
      expect(await daiArbitrage.totalProfits()).to.be.gt(0);
    });
  });

  // ==========================================================================
  // 8. Gas Benchmarks
  // ==========================================================================
  describe('8. Gas Benchmarks', () => {
    it('should execute 2-hop arbitrage within gas budget', async () => {
      const { daiArbitrage, dexRouter1, dai, weth, owner, user } =
        await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure profitable rates: DAI -> WETH -> DAI
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005')
      );
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await dai.getAddress(),
        ethers.parseEther('2100') // Profitable return
      );

      const swapPath = build2HopPath(
        await dexRouter1.getAddress(),
        await dai.getAddress(),
        await weth.getAddress(),
        1n, 1n
      );
      const deadline = await getDeadline();

      const tx = await daiArbitrage.connect(user).executeArbitrage(
        ethers.parseEther('10000'), swapPath, 0n, deadline
      );
      const receipt = await tx.wait();

      // DssFlash mint + 2 swaps, no pool fee overhead — budget < 400,000 gas
      expect(receipt!.gasUsed).to.be.lt(400_000);
    });
  });
});
