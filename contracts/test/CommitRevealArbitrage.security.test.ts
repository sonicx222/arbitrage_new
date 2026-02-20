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
} from './helpers';

/**
 * CommitRevealArbitrage - Security Tests
 *
 * Split from CommitRevealArbitrage.test.ts for maintainability.
 * Tests reveal phase security including:
 * - Wrong commitment hash rejection
 * - Parameter manipulation detection
 * - Expired commitment handling
 * - Reentrancy attack resistance
 *
 * @see CommitRevealArbitrage.test.ts for deployment, commit, and timing tests
 * @see CommitRevealArbitrage.execution.test.ts for swap execution and profit tests
 * @see contracts/src/CommitRevealArbitrage.sol
 */
describe('CommitRevealArbitrage Security', () => {
  // Use shared fixture from helpers/commit-reveal.ts
  const deployContractsFixture = deployCommitRevealFixture;

  // ===========================================================================
  // 4. Reveal Phase - Security Tests
  // ===========================================================================
  describe('4. Reveal Phase - Security', () => {
    it('should revert on wrong commitment hash', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
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

      // Try to reveal with wrong parameters
      const wrongSalt = ethers.randomBytes(32);
      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: wrongSalt // Wrong salt!
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
    });

    it('should revert with CommitmentNotFound when reveal uses wrong amountIn', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
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

      // Reveal with wrong amountIn — hash won't match committed hash
      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: ethers.parseEther('2'), // Wrong amount!
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
    });

    it('should revert with CommitmentNotFound when reveal uses wrong asset', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
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

      // Reveal with wrong asset — hash won't match committed hash
      const revealParams = {
        asset: await usdc.getAddress(), // Wrong asset!
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
    });

    it('should revert on unauthorized revealer', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user, attacker } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
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

      // User commits
      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      // Attacker tries to reveal — with msg.sender in the hash, the attacker's
      // hash differs from the committed hash, so CommitmentNotFound fires first
      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(attacker).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
    });

    it('should revert on already revealed commitment', async () => {
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

      // First reveal should succeed
      await commitRevealArbitrage.connect(user).reveal(revealParams);

      // Second reveal should fail - commitments are deleted after reveal, so we get CommitmentNotFound
      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
    });

    it('should prevent replay attacks', async () => {
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

      await commitRevealArbitrage.connect(user).reveal(revealParams);

      // Verify commitment is marked as revealed
      expect(await commitRevealArbitrage.revealed(commitmentHash)).to.be.true;

      // Verify commitment storage is deleted
      expect(await commitRevealArbitrage.commitments(commitmentHash)).to.equal(0);
    });

    it('should validate deadline correctly', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const currentTime = (await ethers.provider.getBlock('latest'))!.timestamp;
      const pastDeadline = currentTime - 100; // Deadline in the past
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        pastDeadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: pastDeadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InvalidDeadline');
    });

    it('should revert on deadline exceeding MAX_SWAP_DEADLINE', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const currentTime = (await ethers.provider.getBlock('latest'))!.timestamp;
      const farFutureDeadline = currentTime + 700; // > MAX_SWAP_DEADLINE (600)
      const salt = ethers.randomBytes(32);

      const commitmentHash = createCommitmentHash(
        user.address,
        await weth.getAddress(),
        amountIn,
        swapPath,
        0n,
        farFutureDeadline,
        ethers.hexlify(salt)
      );

      await commitRevealArbitrage.connect(user).commit(commitmentHash);
      await mineBlocks(1);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: farFutureDeadline,
        salt: salt
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InvalidDeadline');
    });

    it('should revert on unapproved router', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      // Don't approve the router

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(), // Not approved!
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
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
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'RouterNotApproved');
    });

    it('should revert with CommitmentNotFound (not InvalidCommitmentHash) on wrong reveal params', async () => {
      // Note: InvalidCommitmentHash is declared at CommitRevealArbitrage.sol:180 but is
      // unreachable. When reveal params differ from the committed params, the keccak256
      // hash of the reveal params produces a completely different hash that does not match
      // any stored commitment, so the lookup hits CommitmentNotFound before
      // InvalidCommitmentHash could ever be reached. This test documents that behavior.
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const amountIn = ethers.parseEther('1');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
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

      // Reveal with a different salt produces a different hash that is not found
      const differentSalt = ethers.randomBytes(32);
      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: differentSalt, // Different salt -> different hash -> CommitmentNotFound
      };

      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
    });
  });

  // ===========================================================================
  // 4b. Reentrancy Attack Tests
  // ===========================================================================
  describe('4b. Reentrancy Attack', () => {
    it('should prevent reentrancy attacks during reveal', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, dai, owner, user } =
        await loadFixture(deployContractsFixture);

      // Deploy malicious router that tries reentrancy during swap execution
      const MaliciousRouterFactory = await ethers.getContractFactory('MockMaliciousRouter');
      const maliciousRouter = await MaliciousRouterFactory.deploy(
        await commitRevealArbitrage.getAddress()
      );

      await commitRevealArbitrage.connect(owner).addApprovedRouter(await maliciousRouter.getAddress());
      await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Fund the malicious router with enough tokens (1:1 passthrough uses raw amounts)
      // Use DAI (18 decimals) to match WETH (18 decimals) so 1:1 raw swap works cleanly
      await weth.mint(await maliciousRouter.getAddress(), ethers.parseEther('100'));
      await dai.mint(await maliciousRouter.getAddress(), ethers.parseEther('100'));

      // Set favorable exchange rate on dexRouter1 for the 2nd hop to generate profit
      // DAI→WETH at rate that gives 1% profit: 10 DAI → 10.1 WETH
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('1.01') // 1.01 WETH per DAI (1% profit)
      );

      // Path: WETH→DAI (malicious, 1:1 + reentrancy) → DAI→WETH (normal, 1% profit)
      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await maliciousRouter.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(),
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

      // Commit
      await commitRevealArbitrage.connect(user).commit(commitmentHash);

      // Mine 1 block to satisfy MIN_DELAY_BLOCKS
      await mineBlocks(1);

      // Fund the contract for the reveal
      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      // The reentrancy attack in the first swap triggers a re-entrant call.
      // The malicious router tries to call executeArbitrage() which is blocked
      // by the nonReentrant lock held by reveal().
      await commitRevealArbitrage.connect(user).reveal(revealParams);

      // Verify the attack was actually attempted but failed
      expect(await maliciousRouter.attackAttempted()).to.be.true;
      expect(await maliciousRouter.attackSucceeded()).to.be.false;
    });
  });
});
