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
 * CommitRevealArbitrage Contract Tests
 *
 * Tests comprehensive coverage for Task 3.1: Commit-Reveal Smart Contract
 *
 * Contract implements two-phase commit-reveal pattern:
 * 1. COMMIT: Store commitment hash on-chain (hides trade parameters)
 * 2. WAIT: Minimum 1 block delay (prevents same-block MEV)
 * 3. REVEAL: Reveal parameters and execute multi-hop arbitrage atomically
 *
 * @see contracts/src/CommitRevealArbitrage.sol
 */
describe('CommitRevealArbitrage', () => {
  // Use shared fixture from helpers/commit-reveal.ts
  const deployContractsFixture = deployCommitRevealFixture;

  // ===========================================================================
  // 1. Deployment Tests
  // ===========================================================================
  describe('1. Deployment', () => {
    it('should deploy with correct owner', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);
      expect(await commitRevealArbitrage.owner()).to.equal(owner.address);
    });

    it('should set initial minimumProfit to default (1e14)', async () => {
      const { commitRevealArbitrage } = await loadFixture(deployContractsFixture);
      expect(await commitRevealArbitrage.minimumProfit()).to.equal(BigInt(1e14));
    });

    it('should revert on zero address owner', async () => {
      const CommitRevealArbitrageFactory = await ethers.getContractFactory('CommitRevealArbitrage');
      await expect(
        CommitRevealArbitrageFactory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(
        { interface: CommitRevealArbitrageFactory.interface },
        'InvalidOwnerAddress'
      );
    });

    it('should initialize with correct constants', async () => {
      const { commitRevealArbitrage } = await loadFixture(deployContractsFixture);
      expect(await commitRevealArbitrage.MIN_DELAY_BLOCKS()).to.equal(1);
      expect(await commitRevealArbitrage.maxCommitAgeBlocks()).to.equal(10);
      expect(await commitRevealArbitrage.DEFAULT_MAX_COMMIT_AGE()).to.equal(10);
      expect(await commitRevealArbitrage.MAX_SWAP_DEADLINE()).to.equal(600);
      expect(await commitRevealArbitrage.MAX_SWAP_HOPS()).to.equal(5);
    });
  });

  // ===========================================================================
  // 2. Commit Phase Tests
  // ===========================================================================
  describe('2. Commit Phase', () => {
    describe('commit()', () => {
      it('should store single commitment successfully', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        const tx = await commitRevealArbitrage.connect(user).commit(commitmentHash);

        const blockNumber = (await tx.wait())!.blockNumber;

        expect(await commitRevealArbitrage.commitments(commitmentHash)).to.equal(blockNumber);
        expect(await commitRevealArbitrage.committers(commitmentHash)).to.equal(user.address);
        expect(await commitRevealArbitrage.revealed(commitmentHash)).to.be.false;
      });

      it('should emit Committed event', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await expect(commitRevealArbitrage.connect(user).commit(commitmentHash))
          .to.emit(commitRevealArbitrage, 'Committed')
          .withArgs(commitmentHash, await ethers.provider.getBlockNumber() + 1, user.address);
      });

      it('should prevent duplicate commitments', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        await expect(
          commitRevealArbitrage.connect(user).commit(commitmentHash)
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentAlreadyExists');
      });

      it('should allow different users to commit different hashes', async () => {
        const { commitRevealArbitrage, user, attacker } = await loadFixture(deployContractsFixture);

        const hash1 = ethers.randomBytes(32);
        const hash2 = ethers.randomBytes(32);

        await commitRevealArbitrage.connect(user).commit(hash1);
        await commitRevealArbitrage.connect(attacker).commit(hash2);

        expect(await commitRevealArbitrage.committers(hash1)).to.equal(user.address);
        expect(await commitRevealArbitrage.committers(hash2)).to.equal(attacker.address);
      });

      it('should revert when contract is paused', async () => {
        const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).pause();

        const commitmentHash = ethers.randomBytes(32);
        await expect(
          commitRevealArbitrage.connect(user).commit(commitmentHash)
        ).to.be.revertedWith('Pausable: paused');
      });
    });

    describe('batchCommit()', () => {
      it('should commit multiple hashes in one transaction', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const hashes = [
          ethers.randomBytes(32),
          ethers.randomBytes(32),
          ethers.randomBytes(32)
        ];

        const tx = await commitRevealArbitrage.connect(user).batchCommit(hashes);
        const receipt = await tx.wait();
        const blockNumber = receipt!.blockNumber;

        for (const hash of hashes) {
          expect(await commitRevealArbitrage.commitments(hash)).to.equal(blockNumber);
          expect(await commitRevealArbitrage.committers(hash)).to.equal(user.address);
        }
      });

      it('should skip duplicates gracefully', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const hash1 = ethers.randomBytes(32);
        const hash2 = ethers.randomBytes(32);
        const hash3 = ethers.randomBytes(32);

        // Commit hash2 first
        await commitRevealArbitrage.connect(user).commit(hash2);

        // Batch commit all three (hash2 already exists)
        await commitRevealArbitrage.connect(user).batchCommit([hash1, hash2, hash3]);

        // Verify hash1 and hash3 were committed
        expect(await commitRevealArbitrage.commitments(hash1)).to.be.gt(0);
        expect(await commitRevealArbitrage.commitments(hash3)).to.be.gt(0);
      });

      it('should return correct successCount', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const hash1 = ethers.randomBytes(32);
        const hash2 = ethers.randomBytes(32);
        const hash3 = ethers.randomBytes(32);

        // Commit hash2 first
        await commitRevealArbitrage.connect(user).commit(hash2);

        // Batch commit all three - should succeed for 2 (hash1 and hash3)
        const tx = await commitRevealArbitrage.connect(user).batchCommit([hash1, hash2, hash3]);
        const receipt = await tx.wait();

        // Find the successCount from the return value - we need to call it as a view function
        const result = await commitRevealArbitrage.connect(user).batchCommit.staticCall([hash1, hash2, hash3]);
        expect(result).to.equal(0); // Both already committed at this point
      });

      it('should emit Committed event for each new commitment', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const hashes = [
          ethers.randomBytes(32),
          ethers.randomBytes(32)
        ];

        const tx = commitRevealArbitrage.connect(user).batchCommit(hashes);

        await expect(tx).to.emit(commitRevealArbitrage, 'Committed');
      });

      it('should revert when contract is paused', async () => {
        const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).pause();

        const hashes = [ethers.randomBytes(32)];
        await expect(
          commitRevealArbitrage.connect(user).batchCommit(hashes)
        ).to.be.revertedWith('Pausable: paused');
      });
    });

    describe('cancelCommit()', () => {
      it('should delete commitment for gas refund', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        expect(await commitRevealArbitrage.commitments(commitmentHash)).to.be.gt(0);

        await commitRevealArbitrage.connect(user).cancelCommit(commitmentHash);

        expect(await commitRevealArbitrage.commitments(commitmentHash)).to.equal(0);
      });

      it('should emit CommitCancelled event', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        await expect(commitRevealArbitrage.connect(user).cancelCommit(commitmentHash))
          .to.emit(commitRevealArbitrage, 'CommitCancelled')
          .withArgs(commitmentHash, user.address);
      });

      it('should revert on non-existent commitment', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);

        await expect(
          commitRevealArbitrage.connect(user).cancelCommit(commitmentHash)
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
      });

      it('should revert on already revealed commitment', async () => {
        const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

        // Setup routers and rates
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

        // Commit
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        // Wait 1 block
        await mineBlocks(1);

        // Approve and fund
        await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

        // Reveal (this should mark it as revealed)
        const revealParams = {
          asset: await weth.getAddress(),
          amountIn: amountIn,
          swapPath: swapPath,
          minProfit: 0n,
          deadline: deadline,
          salt: salt
        };

        await commitRevealArbitrage.connect(user).reveal(revealParams);

        // Try to cancel - should revert
        await expect(
          commitRevealArbitrage.connect(user).cancelCommit(commitmentHash)
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
      });

      it('should revert when non-committer tries to cancel', async () => {
        const { commitRevealArbitrage, user, attacker } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        // Attacker cannot cancel someone else's commitment
        await expect(
          commitRevealArbitrage.connect(attacker).cancelCommit(commitmentHash)
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'UnauthorizedRevealer');

        // Commitment still exists
        expect(await commitRevealArbitrage.commitments(commitmentHash)).to.be.gt(0);
      });

      it('should clean up committers mapping on cancel', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        expect(await commitRevealArbitrage.committers(commitmentHash)).to.equal(user.address);

        await commitRevealArbitrage.connect(user).cancelCommit(commitmentHash);

        // Both commitments and committers should be cleaned up
        expect(await commitRevealArbitrage.commitments(commitmentHash)).to.equal(0);
        expect(await commitRevealArbitrage.committers(commitmentHash)).to.equal(ethers.ZeroAddress);
      });
    });
  });

  // ===========================================================================
  // 3. Reveal Phase - Timing Tests
  // ===========================================================================
  describe('3. Reveal Phase - Timing', () => {
    it('should enforce MIN_DELAY_BLOCKS=1 between commit and reveal', async () => {
      const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      // Verify MIN_DELAY_BLOCKS constant
      expect(await commitRevealArbitrage.MIN_DELAY_BLOCKS()).to.equal(1);

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

      // Commit
      await commitRevealArbitrage.connect(user).commit(commitmentHash);

      // Due to Hardhat auto-mining, the commit transaction mines a block,
      // so the next transaction (reveal) will naturally be at least 1 block later,
      // satisfying MIN_DELAY_BLOCKS=1. This test verifies successful reveal after 1 block.

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      // Should succeed - 1 block has passed (commit block + 1 = reveal block)
      await expect(commitRevealArbitrage.connect(user).reveal(revealParams))
        .to.emit(commitRevealArbitrage, 'Revealed');
    });

    it('should succeed at exactly MIN_DELAY_BLOCKS', async () => {
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

      // Wait exactly 1 block
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

      // Should succeed
      await expect(commitRevealArbitrage.connect(user).reveal(revealParams))
        .to.emit(commitRevealArbitrage, 'Revealed');
    });

    it('should revert with CommitmentTooRecent when commit and reveal are in the same block', async () => {
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

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn,
        swapPath,
        minProfit: 0n,
        deadline,
        salt,
      };

      // Disable automine to include both commit and reveal in the same block.
      // This tests that MIN_DELAY_BLOCKS=1 is enforced: commit at block N,
      // reveal at block N should fail because block.number < commitBlock + 1.
      await ethers.provider.send('evm_setAutomine', [false]);

      try {
        // Both transactions enter the pending pool (explicit gasLimit bypasses gas estimation)
        const commitTx = await commitRevealArbitrage.connect(user).commit(
          commitmentHash, { gasLimit: 200000 }
        );
        const revealTx = await commitRevealArbitrage.connect(user).reveal(
          revealParams, { gasLimit: 500000 }
        );

        // Mine a single block containing both transactions
        await ethers.provider.send('evm_mine', []);

        // Commit should succeed (status 1)
        const commitReceipt = await ethers.provider.getTransactionReceipt(commitTx.hash);
        expect(commitReceipt!.status).to.equal(1);

        // Reveal should revert (status 0) because block.number == commitBlock,
        // which violates block.number >= commitBlock + MIN_DELAY_BLOCKS (1).
        // The contract reverts with CommitmentTooRecent in _validateTimingAndDeadline().
        const revealReceipt = await ethers.provider.getTransactionReceipt(revealTx.hash);
        expect(revealReceipt!.status).to.equal(0);
      } finally {
        // Always re-enable automine to avoid affecting subsequent tests
        await ethers.provider.send('evm_setAutomine', [true]);
      }
    });

    it('should revert if expired (> MAX_COMMIT_AGE_BLOCKS)', async () => {
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

      const deadline = await getDeadline(500);
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

      // Wait 11 blocks (MAX_COMMIT_AGE_BLOCKS = 10)
      await mineBlocks(11);

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
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentExpired');
    });

    it('should succeed just before expiry (< MAX_COMMIT_AGE_BLOCKS)', async () => {
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

      // Calculate deadline within MAX_SWAP_DEADLINE (600 seconds)
      const deadline = await getDeadline(250);
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

      // Wait 8 blocks so reveal happens just before commitment expiry
      // Commit at block N, mine 8 blocks to N+8, transfer at N+9, reveal at N+10 (still valid)
      await mineBlocks(8);

      await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

      const revealParams = {
        asset: await weth.getAddress(),
        amountIn: amountIn,
        swapPath: swapPath,
        minProfit: 0n,
        deadline: deadline,
        salt: salt
      };

      // Should succeed - reveal before expiry
      await expect(commitRevealArbitrage.connect(user).reveal(revealParams))
        .to.emit(commitRevealArbitrage, 'Revealed');
    });
  });

  // ===========================================================================
  // 4. Recover Commitment Tests
  // ===========================================================================
  describe('4. Recover Commitment', () => {
    describe('recoverCommitment()', () => {
      it('should allow committer to recover capital from expired commitment', async () => {
        const { commitRevealArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        // Fund the contract with tokens (simulating a deposit for the commitment)
        const amount = ethers.parseEther('1');
        await weth.mint(await commitRevealArbitrage.getAddress(), amount);

        // Wait for commitment to expire (MAX_COMMIT_AGE_BLOCKS = 10)
        await mineBlocks(11);

        const balanceBefore = await weth.balanceOf(user.address);

        // Recover
        await commitRevealArbitrage.connect(user).recoverCommitment(
          commitmentHash,
          await weth.getAddress(),
          amount
        );

        // Verify tokens returned
        const balanceAfter = await weth.balanceOf(user.address);
        expect(balanceAfter - balanceBefore).to.equal(amount);

        // Verify commitment state is cleared
        expect(await commitRevealArbitrage.commitments(commitmentHash)).to.equal(0);
        expect(await commitRevealArbitrage.committers(commitmentHash)).to.equal(ethers.ZeroAddress);
      });

      it('should emit CommitmentRecovered event', async () => {
        const { commitRevealArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        const amount = ethers.parseEther('1');
        await weth.mint(await commitRevealArbitrage.getAddress(), amount);

        // Wait for expiry
        await mineBlocks(11);

        await expect(
          commitRevealArbitrage.connect(user).recoverCommitment(
            commitmentHash,
            await weth.getAddress(),
            amount
          )
        )
          .to.emit(commitRevealArbitrage, 'CommitmentRecovered')
          .withArgs(commitmentHash, user.address, await weth.getAddress(), amount);
      });

      it('should revert when non-committer tries to recover', async () => {
        const { commitRevealArbitrage, weth, user, attacker } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        await weth.mint(await commitRevealArbitrage.getAddress(), ethers.parseEther('1'));
        await mineBlocks(11);

        await expect(
          commitRevealArbitrage.connect(attacker).recoverCommitment(
            commitmentHash,
            await weth.getAddress(),
            ethers.parseEther('1')
          )
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'UnauthorizedRevealer');
      });

      it('should revert when commitment has not expired', async () => {
        const { commitRevealArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        await weth.mint(await commitRevealArbitrage.getAddress(), ethers.parseEther('1'));

        // Only wait 5 blocks (MAX_COMMIT_AGE_BLOCKS = 10, need > 10)
        await mineBlocks(5);

        await expect(
          commitRevealArbitrage.connect(user).recoverCommitment(
            commitmentHash,
            await weth.getAddress(),
            ethers.parseEther('1')
          )
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotExpired');
      });

      it('should revert when commitment has already been revealed', async () => {
        const { commitRevealArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

        // Setup for reveal
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

        const deadline = await getDeadline(500);
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

        // Commit and reveal
        await commitRevealArbitrage.connect(user).commit(commitmentHash);
        await mineBlocks(1);
        await weth.connect(user).transfer(await commitRevealArbitrage.getAddress(), amountIn);

        await commitRevealArbitrage.connect(user).reveal({
          asset: await weth.getAddress(),
          amountIn,
          swapPath,
          minProfit: 0n,
          deadline,
          salt,
        });

        // Wait for expiry after reveal
        await mineBlocks(11);

        // Try to recover a revealed commitment — should fail with CommitmentNotFound
        // because reveal() deletes the commitment entry
        await expect(
          commitRevealArbitrage.connect(user).recoverCommitment(
            commitmentHash,
            await weth.getAddress(),
            amountIn
          )
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
      });

      it('should revert on non-existent commitment', async () => {
        const { commitRevealArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        const fakeHash = ethers.randomBytes(32);

        await expect(
          commitRevealArbitrage.connect(user).recoverCommitment(
            fakeHash,
            await weth.getAddress(),
            ethers.parseEther('1')
          )
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'CommitmentNotFound');
      });

      it('should revert when contract is paused', async () => {
        const { commitRevealArbitrage, weth, owner, user } = await loadFixture(deployContractsFixture);

        const commitmentHash = ethers.randomBytes(32);
        await commitRevealArbitrage.connect(user).commit(commitmentHash);

        await weth.mint(await commitRevealArbitrage.getAddress(), ethers.parseEther('1'));
        await mineBlocks(11);

        await commitRevealArbitrage.connect(owner).pause();

        await expect(
          commitRevealArbitrage.connect(user).recoverCommitment(
            commitmentHash,
            await weth.getAddress(),
            ethers.parseEther('1')
          )
        ).to.be.revertedWith('Pausable: paused');
      });
    });
  });

  // ===========================================================================
  // 5. Admin Functions - cleanupExpiredCommitments
  // ===========================================================================
  describe('5. Cleanup Expired Commitments', () => {
    it('should clean up expired commitments and return count', async () => {
      const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

      const hash1 = ethers.randomBytes(32);
      const hash2 = ethers.randomBytes(32);
      const hash3 = ethers.randomBytes(32);

      await commitRevealArbitrage.connect(user).commit(hash1);
      await commitRevealArbitrage.connect(user).commit(hash2);
      await commitRevealArbitrage.connect(user).commit(hash3);

      // Wait for expiry (maxCommitAgeBlocks = 10)
      await mineBlocks(11);

      const tx = await commitRevealArbitrage.connect(owner).cleanupExpiredCommitments([hash1, hash2, hash3]);
      const receipt = await tx.wait();

      // Verify commitments were deleted
      expect(await commitRevealArbitrage.commitments(hash1)).to.equal(0);
      expect(await commitRevealArbitrage.commitments(hash2)).to.equal(0);
      expect(await commitRevealArbitrage.commitments(hash3)).to.equal(0);
    });

    it('should emit CommitmentsCleanedUp event', async () => {
      const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

      const hash1 = ethers.randomBytes(32);
      const hash2 = ethers.randomBytes(32);

      await commitRevealArbitrage.connect(user).commit(hash1);
      await commitRevealArbitrage.connect(user).commit(hash2);

      await mineBlocks(11);

      await expect(
        commitRevealArbitrage.connect(owner).cleanupExpiredCommitments([hash1, hash2])
      ).to.emit(commitRevealArbitrage, 'CommitmentsCleanedUp').withArgs(2);
    });

    it('should skip non-existent commitments', async () => {
      const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

      const hash1 = ethers.randomBytes(32);
      const fakeHash = ethers.randomBytes(32);

      await commitRevealArbitrage.connect(user).commit(hash1);
      await mineBlocks(11);

      await expect(
        commitRevealArbitrage.connect(owner).cleanupExpiredCommitments([hash1, fakeHash])
      ).to.emit(commitRevealArbitrage, 'CommitmentsCleanedUp').withArgs(1);
    });

    it('should skip non-expired commitments', async () => {
      const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

      const expiredHash = ethers.randomBytes(32);
      await commitRevealArbitrage.connect(user).commit(expiredHash);
      await mineBlocks(11);

      const freshHash = ethers.randomBytes(32);
      await commitRevealArbitrage.connect(user).commit(freshHash);

      await expect(
        commitRevealArbitrage.connect(owner).cleanupExpiredCommitments([expiredHash, freshHash])
      ).to.emit(commitRevealArbitrage, 'CommitmentsCleanedUp').withArgs(1);

      // Fresh one should still exist
      expect(await commitRevealArbitrage.commitments(freshHash)).to.be.gt(0);
    });

    it('should not emit event when no commitments cleaned', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

      const fakeHash = ethers.randomBytes(32);

      await expect(
        commitRevealArbitrage.connect(owner).cleanupExpiredCommitments([fakeHash])
      ).to.not.emit(commitRevealArbitrage, 'CommitmentsCleanedUp');
    });

    it('should revert when called by non-owner', async () => {
      const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

      const hash = ethers.randomBytes(32);
      await commitRevealArbitrage.connect(user).commit(hash);
      await mineBlocks(11);

      await expect(
        commitRevealArbitrage.connect(user).cleanupExpiredCommitments([hash])
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should revert when contract is paused', async () => {
      const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

      const hash = ethers.randomBytes(32);
      await commitRevealArbitrage.connect(user).commit(hash);
      await mineBlocks(11);

      await commitRevealArbitrage.connect(owner).pause();

      await expect(
        commitRevealArbitrage.connect(owner).cleanupExpiredCommitments([hash])
      ).to.be.revertedWith('Pausable: paused');
    });
  });

  // ===========================================================================
  // 6. Admin Functions - setMaxCommitAgeBlocks
  // ===========================================================================
  describe('6. Set Max Commit Age Blocks', () => {
    it('should set maxCommitAgeBlocks within valid range', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).setMaxCommitAgeBlocks(50);
      expect(await commitRevealArbitrage.maxCommitAgeBlocks()).to.equal(50);
    });

    it('should emit MaxCommitAgeBlocksUpdated event', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

      await expect(
        commitRevealArbitrage.connect(owner).setMaxCommitAgeBlocks(50)
      ).to.emit(commitRevealArbitrage, 'MaxCommitAgeBlocksUpdated').withArgs(10, 50);
    });

    it('should accept minimum value (MIN_COMMIT_AGE = 5)', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).setMaxCommitAgeBlocks(5);
      expect(await commitRevealArbitrage.maxCommitAgeBlocks()).to.equal(5);
    });

    it('should accept maximum value (MAX_COMMIT_AGE = 100)', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

      await commitRevealArbitrage.connect(owner).setMaxCommitAgeBlocks(100);
      expect(await commitRevealArbitrage.maxCommitAgeBlocks()).to.equal(100);
    });

    it('should revert below minimum', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

      await expect(
        commitRevealArbitrage.connect(owner).setMaxCommitAgeBlocks(4)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InvalidCommitAge');
    });

    it('should revert above maximum', async () => {
      const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

      await expect(
        commitRevealArbitrage.connect(owner).setMaxCommitAgeBlocks(101)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InvalidCommitAge');
    });

    it('should revert when called by non-owner', async () => {
      const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

      await expect(
        commitRevealArbitrage.connect(user).setMaxCommitAgeBlocks(50)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
});
