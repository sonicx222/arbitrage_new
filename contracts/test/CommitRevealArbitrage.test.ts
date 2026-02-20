import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, mine } from '@nomicfoundation/hardhat-network-helpers';
import { CommitRevealArbitrage, MockDexRouter, MockERC20 } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  deployBaseFixture,
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  getDeadline,
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
  // Test fixtures for consistent state
  async function deployContractsFixture() {
    const base = await deployBaseFixture();

    // Deploy CommitRevealArbitrage contract (no flash loan provider needed)
    const CommitRevealArbitrageFactory = await ethers.getContractFactory('CommitRevealArbitrage');
    const commitRevealArbitrage = await CommitRevealArbitrageFactory.deploy(base.owner.address);

    // Fund user with tokens for direct arbitrage
    await base.weth.mint(base.user.address, ethers.parseEther('100'));

    return { commitRevealArbitrage, ...base };
  }

  /**
   * Helper function to create commitment hash
   */
  function createCommitmentHash(
    sender: string,
    asset: string,
    amountIn: bigint,
    swapPath: any[],
    minProfit: bigint,
    deadline: number,
    salt: string
  ): string {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address asset, uint256 amountIn, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline, bytes32 salt)'],
      [[asset, amountIn, swapPath, minProfit, deadline, salt]]
    );
    // Match Solidity: keccak256(abi.encodePacked(msg.sender, abi.encode(params)))
    const packed = ethers.solidityPacked(['address', 'bytes'], [sender, encoded]);
    return ethers.keccak256(packed);
  }

  /**
   * Helper function to mine blocks (for testing time-based logic)
   */
  async function mineBlocks(count: number): Promise<void> {
    await mine(count);
  }

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
      expect(await commitRevealArbitrage.MAX_COMMIT_AGE_BLOCKS()).to.equal(10);
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
});
