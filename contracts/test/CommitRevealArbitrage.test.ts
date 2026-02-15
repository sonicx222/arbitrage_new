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

    it('should set initial minimumProfit to 0', async () => {
      const { commitRevealArbitrage } = await loadFixture(deployContractsFixture);
      expect(await commitRevealArbitrage.minimumProfit()).to.equal(0);
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

    it('should enforce profit threshold via InsufficientProfit (not BelowMinimumProfit)', async () => {
      // Note: BelowMinimumProfit is declared at CommitRevealArbitrage.sol:183 but is unused.
      // BaseFlashArbitrage._verifyAndTrackProfit() uses InsufficientProfit for all profit
      // threshold checks. This test documents that the contract-level minimumProfit
      // enforcement uses InsufficientProfit, not BelowMinimumProfit.
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

      // The profit check uses InsufficientProfit from BaseFlashArbitrage, not BelowMinimumProfit
      await expect(
        commitRevealArbitrage.connect(user).reveal(revealParams)
      ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InsufficientProfit');
    });
  });

  // ===========================================================================
  // 7. Admin Function Tests
  // ===========================================================================
  describe('7. Admin Functions', () => {
    describe('addApprovedRouter()', () => {
      it('should allow owner to approve router', async () => {
        const { commitRevealArbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        expect(await commitRevealArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
      });

      it('should emit RouterAdded event', async () => {
        const { commitRevealArbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await expect(commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress()))
          .to.emit(commitRevealArbitrage, 'RouterAdded')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should revert if non-owner tries to approve', async () => {
        const { commitRevealArbitrage, dexRouter1, owner, user } = await loadFixture(deployContractsFixture);

        await expect(
          commitRevealArbitrage.connect(user).addApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should revert on zero address router', async () => {
        const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          commitRevealArbitrage.connect(owner).addApprovedRouter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(commitRevealArbitrage, 'InvalidRouterAddress');
      });
    });

    describe('removeApprovedRouter()', () => {
      it('should allow owner to remove router', async () => {
        const { commitRevealArbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        expect(await commitRevealArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;

        await commitRevealArbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress());
        expect(await commitRevealArbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.false;
      });

      it('should emit RouterRemoved event', async () => {
        const { commitRevealArbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(commitRevealArbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress()))
          .to.emit(commitRevealArbitrage, 'RouterRemoved')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should revert if non-owner tries to remove', async () => {
        const { commitRevealArbitrage, dexRouter1, owner, user } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          commitRevealArbitrage.connect(user).removeApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('setMinimumProfit()', () => {
      it('should allow owner to update minimum profit', async () => {
        const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

        const newMinProfit = ethers.parseEther('0.05');
        await commitRevealArbitrage.connect(owner).setMinimumProfit(newMinProfit);

        expect(await commitRevealArbitrage.minimumProfit()).to.equal(newMinProfit);
      });

      it('should emit MinimumProfitUpdated event', async () => {
        const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

        const newMinProfit = ethers.parseEther('0.05');
        await expect(commitRevealArbitrage.connect(owner).setMinimumProfit(newMinProfit))
          .to.emit(commitRevealArbitrage, 'MinimumProfitUpdated')
          .withArgs(0, newMinProfit);
      });

      it('should revert if non-owner tries to update', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          commitRevealArbitrage.connect(user).setMinimumProfit(ethers.parseEther('0.05'))
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('pause() / unpause()', () => {
      it('should allow owner to pause', async () => {
        const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).pause();
        expect(await commitRevealArbitrage.paused()).to.be.true;
      });

      it('should allow owner to unpause', async () => {
        const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).pause();
        expect(await commitRevealArbitrage.paused()).to.be.true;

        await commitRevealArbitrage.connect(owner).unpause();
        expect(await commitRevealArbitrage.paused()).to.be.false;
      });

      it('should revert if non-owner tries to pause', async () => {
        const { commitRevealArbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          commitRevealArbitrage.connect(user).pause()
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should revert if non-owner tries to unpause', async () => {
        const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).pause();

        await expect(
          commitRevealArbitrage.connect(user).unpause()
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('withdrawToken()', () => {
      it('should allow owner to withdraw stuck tokens', async () => {
        const { commitRevealArbitrage, weth, owner } = await loadFixture(deployContractsFixture);

        // Send some WETH to contract
        await weth.mint(await commitRevealArbitrage.getAddress(), ethers.parseEther('1'));

        const ownerBalanceBefore = await weth.balanceOf(owner.address);

        await commitRevealArbitrage.connect(owner).withdrawToken(
          await weth.getAddress(),
          owner.address,
          ethers.parseEther('1')
        );

        const ownerBalanceAfter = await weth.balanceOf(owner.address);
        expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther('1'));
      });

      it('should revert if non-owner tries to withdraw', async () => {
        const { commitRevealArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        await weth.mint(await commitRevealArbitrage.getAddress(), ethers.parseEther('1'));

        await expect(
          commitRevealArbitrage.connect(user).withdrawToken(
            await weth.getAddress(),
            user.address,
            ethers.parseEther('1')
          )
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('withdrawETH()', () => {
      it('should allow owner to withdraw ETH', async () => {
        const { commitRevealArbitrage, owner } = await loadFixture(deployContractsFixture);

        // Send some ETH to contract
        await owner.sendTransaction({
          to: await commitRevealArbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

        const tx = await commitRevealArbitrage.connect(owner).withdrawETH(
          owner.address,
          ethers.parseEther('1')
        );
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * BigInt(receipt!.gasPrice ?? 0);

        const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
        expect(ownerBalanceAfter).to.be.closeTo(
          ownerBalanceBefore + ethers.parseEther('1') - gasUsed,
          ethers.parseEther('0.01')
        );
      });

      it('should revert if non-owner tries to withdraw ETH', async () => {
        const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await owner.sendTransaction({
          to: await commitRevealArbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        await expect(
          commitRevealArbitrage.connect(user).withdrawETH(user.address, ethers.parseEther('1'))
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('Ownable2Step', () => {
      it('should support two-step ownership transfer', async () => {
        const { commitRevealArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        // Step 1: Current owner initiates transfer
        await commitRevealArbitrage.connect(owner).transferOwnership(user.address);

        // Owner is still the original owner (pending transfer)
        expect(await commitRevealArbitrage.owner()).to.equal(owner.address);
        expect(await commitRevealArbitrage.pendingOwner()).to.equal(user.address);

        // Step 2: New owner accepts
        await commitRevealArbitrage.connect(user).acceptOwnership();

        // Now ownership is transferred
        expect(await commitRevealArbitrage.owner()).to.equal(user.address);
      });

      it('should not allow non-pending owner to accept', async () => {
        const { commitRevealArbitrage, owner, user, attacker } = await loadFixture(deployContractsFixture);

        await commitRevealArbitrage.connect(owner).transferOwnership(user.address);

        await expect(
          commitRevealArbitrage.connect(attacker).acceptOwnership()
        ).to.be.revertedWith('Ownable2Step: caller is not the new owner');
      });
    });
  });

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
});
