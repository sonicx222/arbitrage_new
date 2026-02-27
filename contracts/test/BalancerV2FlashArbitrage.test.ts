import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { BalancerV2FlashArbitrage, MockDexRouter, MockERC20, MockBalancerVault } from '../typechain-types';
import {
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  getDeadline,
  deployBalancerV2Fixture,
  testDeploymentDefaults,
  testInputValidation,
} from './helpers';

/**
 * BalancerV2FlashArbitrage Contract Tests
 *
 * Tests comprehensive coverage for Task 2.2: Balancer V2 Flash Loan Provider
 *
 * Contract uses Balancer V2 flash loans (0% fees) for arbitrage execution.
 * Key features:
 * - Single Vault contract per chain (no pool discovery)
 * - Zero flash loan fees
 * - Multi-hop swap execution
 * - Router approval system
 * - Profit verification
 *
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */
describe('BalancerV2FlashArbitrage', () => {
  // Use shared fixture from helpers/balancer-v2.ts
  const deployContractsFixture = deployBalancerV2Fixture;

  // ===========================================================================
  // 1. Deployment Defaults (shared) + Balancer-Specific Deployment
  // ===========================================================================
  testDeploymentDefaults({
    contractName: 'BalancerV2FlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return { contract: f.arbitrage, owner: f.owner };
    },
  });

  describe('Deployment — Balancer-Specific', () => {
    it('should deploy with correct vault address', async () => {
      const { arbitrage, vault } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.VAULT()).to.equal(await vault.getAddress());
    });

    it('should revert on zero vault address', async () => {
      const { owner } = await loadFixture(deployContractsFixture);
      const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory('BalancerV2FlashArbitrage');

      await expect(
        BalancerV2FlashArbitrageFactory.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: BalancerV2FlashArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should revert on EOA vault address (no code)', async () => {
      const { owner, user } = await loadFixture(deployContractsFixture);
      const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory('BalancerV2FlashArbitrage');

      await expect(
        BalancerV2FlashArbitrageFactory.deploy(user.address, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: BalancerV2FlashArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });
  });

  // ===========================================================================
  // Input Validation (shared — _validateArbitrageParams)
  // ===========================================================================
  testInputValidation({
    contractName: 'BalancerV2FlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.arbitrage,
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
  // 3. Flash Loan Execution Tests
  // ===========================================================================
  describe('3. Flash Loan Execution', () => {
    it('should execute simple arbitrage successfully', async () => {
      const { arbitrage, vault, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      // Setup: Approve router and set profitable exchange rates (using same pattern as CommitRevealArbitrage tests)
      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // WETH -> USDC: 1 WETH = 2000 USDC
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );

      // USDC -> WETH: rate that gives profit
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT
      );

      const amount = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('1900', 6),
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('0.99'),
        },
      ];

      const deadline = await getDeadline();

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        amount,
        swapPath,
        0,
        deadline
      );

      // Verify profit was made
      const contractBalance = await weth.balanceOf(await arbitrage.getAddress());
      expect(contractBalance).to.be.gt(0);
    });

    it('should emit ArbitrageExecuted event', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_2PCT_PROFIT
      );

      const amount = ethers.parseEther('10');
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
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9.5'),
        },
      ];

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          amount,
          swapPath,
          0,
          deadline
        )
      ).to.emit(arbitrage, 'ArbitrageExecuted');
    });

    it('should update totalProfits after execution', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_2PCT_PROFIT
      );

      const amount = ethers.parseEther('10');
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
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9.5'),
        },
      ];

      const deadline = await getDeadline();

      const totalProfitsBefore = await arbitrage.totalProfits();

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        amount,
        swapPath,
        0,
        deadline
      );

      const totalProfitsAfter = await arbitrage.totalProfits();
      expect(totalProfitsAfter).to.be.gt(totalProfitsBefore);
    });

    it('should update tokenProfits per-asset after execution', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_2PCT_PROFIT
      );

      const amount = ethers.parseEther('10');
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
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9.5'),
        },
      ];

      const deadline = await getDeadline();

      // tokenProfits should be 0 for WETH before execution
      const wethProfitsBefore = await arbitrage.tokenProfits(await weth.getAddress());
      expect(wethProfitsBefore).to.equal(0);

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        amount,
        swapPath,
        0,
        deadline
      );

      // tokenProfits should track per-token (WETH), not USDC
      const wethProfitsAfter = await arbitrage.tokenProfits(await weth.getAddress());
      const usdcProfitsAfter = await arbitrage.tokenProfits(await usdc.getAddress());
      expect(wethProfitsAfter).to.be.gt(0);
      expect(usdcProfitsAfter).to.equal(0); // No USDC arbitrage was executed
    });

    it('should revert on zero-profit trade (Fix 4a)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set exchange rates that produce exactly zero profit after swaps
      // (output equals input — the flash loan fee is 0 for Balancer)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('500000000000000000000000000') // 1 USDC = 0.0005 WETH → 10 WETH → 20000 USDC → 10 WETH (break-even)
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

      const deadline = await getDeadline();

      // Even with minProfit=0, a zero-profit trade should revert
      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'InsufficientProfit');
    });
  });

  // ===========================================================================
  // 4. Swap Execution Tests
  // ===========================================================================
  describe('4. Swap Execution (_executeSwaps)', () => {
    it('should execute single-hop swap', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_2PCT_PROFIT
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
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('9.5'),
        },
      ];

      const deadline = await getDeadline();

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );

      expect(await weth.balanceOf(await arbitrage.getAddress())).to.be.gt(0);
    });

    it('should execute multi-hop swap (3 hops)', async () => {
      const { arbitrage, dexRouter1, dexRouter2, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await arbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      // WETH -> USDC
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );

      // USDC -> DAI
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1010000000000000000000000000000')
      );

      // DAI -> WETH
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

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );

      expect(await weth.balanceOf(await arbitrage.getAddress())).to.be.gt(0);
    });

    it('should execute max-hop swap (5 hops)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      // Deploy additional tokens
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const usdt = await MockERC20Factory.deploy('Tether', 'USDT', 6);
      const busd = await MockERC20Factory.deploy('BUSD', 'BUSD', 18);

      await usdt.mint(await dexRouter1.getAddress(), ethers.parseUnits('10000000', 6));
      await busd.mint(await dexRouter1.getAddress(), ethers.parseEther('10000000'));

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure 5-hop path: WETH -> USDC -> DAI -> USDT -> BUSD -> WETH
      await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
      await dexRouter1.setExchangeRate(await usdc.getAddress(), await dai.getAddress(), BigInt('1002000000000000000000000000000'));
      await dexRouter1.setExchangeRate(await dai.getAddress(), await usdt.getAddress(), ethers.parseUnits('1', 6));
      await dexRouter1.setExchangeRate(await usdt.getAddress(), await busd.getAddress(), BigInt('1002000000000000000000000000000'));
      await dexRouter1.setExchangeRate(await busd.getAddress(), await weth.getAddress(), BigInt('505000000000000'));

      const swapPath = [
        { router: await dexRouter1.getAddress(), tokenIn: await weth.getAddress(), tokenOut: await usdc.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await usdc.getAddress(), tokenOut: await dai.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await dai.getAddress(), tokenOut: await usdt.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await usdt.getAddress(), tokenOut: await busd.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await busd.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1 },
      ];

      const deadline = await getDeadline();

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );

      expect(await weth.balanceOf(await arbitrage.getAddress())).to.be.gt(0);
    });

    it('should revert on insufficient output amount', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_2PCT_PROFIT
      );

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: ethers.parseUnits('25000', 6), // Too high!
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWith('Insufficient output amount');
    });
  });

  // ===========================================================================
  // 5. Security Tests
  // ===========================================================================
  describe('5. Security', () => {
    it('should revert receiveFlashLoan when called by non-vault address (GAP-003)', async () => {
      const { arbitrage, weth, attacker } = await loadFixture(deployContractsFixture);

      const tokens = [await weth.getAddress()];
      const amounts = [ethers.parseEther('10')];
      const feeAmounts = [0n];
      const userData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
        [[], 0n]
      );

      await expect(
        arbitrage.connect(attacker).receiveFlashLoan(tokens, amounts, feeAmounts, userData)
      ).to.be.revertedWithCustomError(arbitrage, 'InvalidFlashLoanCaller');
    });
  });

});
