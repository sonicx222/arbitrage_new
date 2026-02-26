import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { CommitRevealArbitrage, MockDexRouter, MockERC20 } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  getDeadline,
  deployCommitRevealFixture,
  createCommitmentHash,
  mineBlocks,
  testRouterManagement,
  testMinimumProfitConfig,
  testPauseUnpause,
  testWithdrawToken,
  testWithdrawETH,
  testWithdrawGasLimitConfig,
  testOwnable2Step,
} from './helpers';

/**
 * CommitRevealArbitrage - Execution, Profit, Admin & View Tests
 *
 * Split from CommitRevealArbitrage.test.ts for maintainability.
 * Tests:
 * - Reveal phase swap execution (single-hop, multi-hop, edge cases)
 * - Profit validation and distribution
 * - Admin functions (router management, pause, withdraw)
 * - View functions (calculateExpectedProfit)
 *
 * @see CommitRevealArbitrage.test.ts for deployment, commit, and timing tests
 * @see CommitRevealArbitrage.security.test.ts for security and reentrancy tests
 * @see contracts/src/CommitRevealArbitrage.sol
 */
describe('CommitRevealArbitrage Execution', () => {
  // Use shared fixture from helpers/commit-reveal.ts
  const deployContractsFixture = deployCommitRevealFixture;

  // Admin test config for shared harness
  const adminConfig = {
    contractName: 'CommitRevealArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.commitRevealArbitrage,
        owner: f.owner,
        user: f.user,
        attacker: f.attacker,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
      };
    },
  };

  // ===========================================================================
  // 5. Reveal Phase - Swap Execution Tests
  // ===========================================================================
  describe('5. Reveal Phase - Swap Execution', () => {
    it('should execute single-hop swap successfully', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT
      );

      const amountIn = ethers.parseEther('1');
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
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      // Transfer tokens to contract for arbitrage
      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const contractBalanceBefore = await weth.balanceOf(await commitRevealArbitrage.getAddress());

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await commitRevealArbitrage.connect(user).reveal(revealParams);

      const contractBalanceAfter = await weth.balanceOf(await commitRevealArbitrage.getAddress());

      // Contract should have made profit
      expect(contractBalanceAfter).to.be.gt(contractBalanceBefore);
    });

    it('should execute multi-hop swap (3 hops)', async () => {
      const { commitRevealArbitrage, dexRouter1, dexRouter2, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      // Configure rates for triangular arbitrage: WETH -> USDC -> DAI -> WETH
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
        BigInt('505000000000000')
      );

      const amountIn = ethers.parseEther('1');
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
          tokenOut: await dai.getAddress(),
          amountOutMin: ethers.parseEther('1900'),
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: ethers.parseEther('0.99'),
        },
      ];

      const deadline = await getDeadline();
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(commitRevealArbitrage.connect(user).reveal(revealParams))
        .to.emit(commitRevealArbitrage, 'Revealed');
    });

    it('should execute max-hop swap (5 hops)', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      // Deploy additional tokens for 5-hop test
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const usdt = await MockERC20Factory.deploy('Tether', 'USDT', 6);
      const busd = await MockERC20Factory.deploy('BUSD', 'BUSD', 18);

      await usdt.mint(await dexRouter1.getAddress(), ethers.parseUnits('1000000', 6));
      await busd.mint(await dexRouter1.getAddress(), ethers.parseEther('1000000'));

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure rates for 5-hop path: WETH -> USDC -> DAI -> USDT -> BUSD -> WETH
      await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
      await dexRouter1.setExchangeRate(await usdc.getAddress(), await dai.getAddress(), BigInt('1002000000000000000000000000000'));
      await dexRouter1.setExchangeRate(await dai.getAddress(), await usdt.getAddress(), ethers.parseUnits('1', 6));
      await dexRouter1.setExchangeRate(await usdt.getAddress(), await busd.getAddress(), BigInt('1002000000000000000000000000000'));
      await dexRouter1.setExchangeRate(await busd.getAddress(), await weth.getAddress(), BigInt('505000000000000'));

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        { router: await dexRouter1.getAddress(), tokenIn: await weth.getAddress(), tokenOut: await usdc.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await usdc.getAddress(), tokenOut: await dai.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await dai.getAddress(), tokenOut: await usdt.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await usdt.getAddress(), tokenOut: await busd.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await busd.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1n },
      ];

      const deadline = await getDeadline();
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(commitRevealArbitrage.connect(user).reveal(revealParams))
        .to.emit(commitRevealArbitrage, 'Revealed');
    });

    it('should revert on path too long (> 5 hops)', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      // Deploy additional tokens for 6-hop test
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const usdt = await MockERC20Factory.deploy('Tether', 'USDT', 6);
      const busd = await MockERC20Factory.deploy('BUSD', 'BUSD', 18);
      const tusd = await MockERC20Factory.deploy('TUSD', 'TUSD', 18);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        { router: await dexRouter1.getAddress(), tokenIn: await weth.getAddress(), tokenOut: await usdc.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await usdc.getAddress(), tokenOut: await dai.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await dai.getAddress(), tokenOut: await usdt.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await usdt.getAddress(), tokenOut: await busd.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await busd.getAddress(), tokenOut: await tusd.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await tusd.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1n },
      ];

      const deadline = await getDeadline();
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'PathTooLong');
    });

    it('should revert on empty swap path', async () => {
      const { commitRevealArbitrage, weth, user } = await loadFixture(deployContractsFixture);

      const amountIn = ethers.parseEther('1');
      const swapPath: any[] = []; // Empty!

      const deadline = await getDeadline();
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'EmptySwapPath');
    });

    it('should revert on asset mismatch (does not start with asset)', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(), // Wrong! Should be WETH
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(), // Asset is WETH
        amountIn,
        swapPath, // But path starts with USDC
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'SwapPathAssetMismatch');
    });

    it('should revert on asset mismatch (does not end with asset)', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(), // Path ends with USDC, not WETH
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InvalidSwapPath');
    });

    it('should revert on token continuity error', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(), // Wrong! Should be USDC
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InvalidSwapPath');
    });
  });

  // ===========================================================================
  // 6. Profit Validation Tests
  // ===========================================================================
  describe('6. Profit Validation', () => {
    it('should revert if profit < params.minProfit', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('500500000000000000000000000') // Gives ~0.01 WETH profit
      );

      const amountIn = ethers.parseEther('1');
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
      const salt = ethers.randomBytes(32);
      const minProfit = ethers.parseEther('0.1'); // Require 0.1 WETH profit (high)

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        minProfit,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: minProfit,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InsufficientProfit');
    });

    it('should revert if profit < contract minimumProfit', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set global minimum profit
      await commitRevealArbitrage.connect(owner).setMinimumProfit(ethers.parseEther('0.1'));

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('500500000000000000000000000') // Gives ~0.01 WETH profit
      );

      const amountIn = ethers.parseEther('1');
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
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n, // User specifies 0, but global is 0.1
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InsufficientProfit');
    });

    it('should use max of params.minProfit and minimumProfit', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set global minimum profit to 0.01
      await commitRevealArbitrage.connect(owner).setMinimumProfit(ethers.parseEther('0.01'));

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('530000000000000000000000000') // Gives ~0.06 WETH profit (1 ETH -> 2000 USDC -> 1.06 ETH)
      );

      const amountIn = ethers.parseEther('1');
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
      const salt = ethers.randomBytes(32);

      // User specifies higher minProfit than global
      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        ethers.parseEther('0.05'), // Higher than global 0.01
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: ethers.parseEther('0.05'),
        deadline: deadline,
        salt: salt
      };

      // Should succeed because profit (~0.1) > max(0.05, 0.01)
      await expect(commitRevealArbitrage.connect(user).reveal(revealParams))
        .to.emit(commitRevealArbitrage, 'Revealed');
    });

    it('should emit Revealed event with correct profit', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT
      );

      const amountIn = ethers.parseEther('1');
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
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      // Check event emission
      const tx = await commitRevealArbitrage.connect(user).reveal(revealParams);
      const receipt = await tx.wait();

      // Find Revealed event
      const revealedEvent = receipt!.logs.find(
        log => {
          try {
            const parsed = commitRevealArbitrage.interface.parseLog({
              topics: log.topics as string[],
              data: log.data
            });
            return parsed?.name === 'Revealed';
          } catch {
            return false;
          }
        }
      );

      expect(revealedEvent).to.not.be.undefined;
    });

    it('should enforce profit threshold via InsufficientProfit', async () => {
      // BaseFlashArbitrage._verifyAndTrackProfit() uses InsufficientProfit for all profit
      // threshold checks, including the contract-level minimumProfit enforcement.
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set a high minimumProfit so the trade fails profit validation
      await commitRevealArbitrage.connect(owner).setMinimumProfit(ethers.parseEther('10'));

      // Set exchange rates that give small profit (not enough to meet minimum)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT // ~1% profit, well below 10 WETH minimum
      );

      const amountIn = ethers.parseEther('1');
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
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        deadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt,
      };

      // The profit check uses InsufficientProfit from BaseFlashArbitrage
      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InsufficientProfit');
    });
  });

  // ===========================================================================
  // 7. Admin Function Tests (shared harness)
  // ===========================================================================
  testRouterManagement(adminConfig);
  testMinimumProfitConfig(adminConfig);
  testPauseUnpause(adminConfig);
  testWithdrawToken(adminConfig);
  testWithdrawETH(adminConfig);
  testWithdrawGasLimitConfig(adminConfig);
  testOwnable2Step(adminConfig);

  // ===========================================================================
  // 8. View Function Tests
  // ===========================================================================
  describe('8. View Functions', () => {
    describe('calculateExpectedProfit()', () => {
      it('should calculate expected profit correctly', async () => {
        const { commitRevealArbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await usdc.getAddress(),
          ethers.parseUnits('2000', 6)
        );
        await dexRouter1.setExchangeRate(
          await usdc.getAddress(),
          await weth.getAddress(),
          RATE_USDC_TO_WETH_1PCT_PROFIT
        );

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

        const profit = await commitRevealArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath
        );

        expect(profit).to.be.gt(0);
        expect(profit).to.be.lt(ethers.parseEther('0.2')); // Sanity check
      });

      it('should return 0 for empty path', async () => {
        const { commitRevealArbitrage, weth } = await loadFixture(deployContractsFixture);

        const profit = await commitRevealArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('1'),
          []
        );

        expect(profit).to.equal(0);
      });

      it('should return 0 for path too long', async () => {
        const { commitRevealArbitrage, dexRouter1, weth, usdc } = await loadFixture(deployContractsFixture);

        const swapPath = Array(6).fill({
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 0n,
        });

        const profit = await commitRevealArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath
        );

        expect(profit).to.equal(0);
      });

      it('should return 0 for invalid path (wrong start token)', async () => {
        const { commitRevealArbitrage, dexRouter1, weth, usdc } = await loadFixture(deployContractsFixture);

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(), // Wrong!
            tokenOut: await weth.getAddress(),
            amountOutMin: 0n,
          },
        ];

        const profit = await commitRevealArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath
        );

        expect(profit).to.equal(0);
      });
    });
  });

  // ===========================================================================
  // 9. Mixed Valid/Invalid Sequential Reveals (GAP-001)
  // ===========================================================================
  describe('9. Mixed Valid/Invalid Sequential Reveals', () => {
    it('should execute valid reveals and revert invalid ones independently', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT
      );

      const amountIn = ethers.parseEther('1');
      const validSwapPath = [
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

      // Create 3 commitments: valid, invalid (wrong amount), valid
      const salt1 = ethers.randomBytes(32);
      const salt2 = ethers.randomBytes(32);
      const salt3 = ethers.randomBytes(32);

      const hash1 = createCommitmentHash(
        user.address, await weth.getAddress(), amountIn, validSwapPath,
        0n, deadline, ethers.hexlify(salt1)
      );
      const hash2 = createCommitmentHash(
        user.address, await weth.getAddress(), amountIn, validSwapPath,
        0n, deadline, ethers.hexlify(salt2)
      );
      const hash3 = createCommitmentHash(
        user.address, await weth.getAddress(), amountIn, validSwapPath,
        0n, deadline, ethers.hexlify(salt3)
      );

      // Commit all three
      await commitRevealArbitrage.connect(user).commit(hash1);
      await commitRevealArbitrage.connect(user).commit(hash2);
      await commitRevealArbitrage.connect(user).commit(hash3);
      await mineBlocks(1);

      // Fund contract for valid reveals
      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      // Reveal 1: Valid — should succeed
      const reveal1Params = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: validSwapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt1,
      };
      await expect(commitRevealArbitrage.connect(user).reveal(reveal1Params))
        .to.emit(commitRevealArbitrage, 'Revealed');

      const profitsAfterFirst = await commitRevealArbitrage.totalProfits();
      expect(profitsAfterFirst).to.be.gt(0);

      // Reveal 2: Invalid — try to reveal with WRONG salt (reveals commitment hash mismatch)
      const wrongSalt = ethers.randomBytes(32);
      const reveal2Params = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: validSwapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: wrongSalt, // Wrong salt — hash won't match any commitment
      };
      await expect(
        commitRevealArbitrage.connect(user).reveal(reveal2Params)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');

      // Verify state unchanged after failed reveal
      expect(await commitRevealArbitrage.totalProfits()).to.equal(profitsAfterFirst);

      // Reveal 3: Valid — fund again and reveal should succeed
      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const reveal3Params = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: validSwapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt3,
      };
      await expect(commitRevealArbitrage.connect(user).reveal(reveal3Params))
        .to.emit(commitRevealArbitrage, 'Revealed');

      // Verify profits accumulated from both valid reveals
      const profitsAfterThird = await commitRevealArbitrage.totalProfits();
      expect(profitsAfterThird).to.be.gt(profitsAfterFirst);
    });

    it('should reject replay of already-revealed commitment', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT
      );

      const amountIn = ethers.parseEther('1');
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
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address, await weth.getAddress(), amountIn, swapPath,
        0n, deadline, ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      // Fund and execute first reveal
      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt,
      };

      await commitRevealArbitrage.connect(user).reveal(revealParams);

      // Attempt replay — should revert. The contract deletes commitments[hash]
      // after successful reveal (gas refund), so replay hits CommitmentNotFound
      // (commitBlock == 0) before reaching the revealed[hash] check.
      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);
      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
    });
  });
});
