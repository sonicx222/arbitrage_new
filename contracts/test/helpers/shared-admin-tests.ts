/**
 * Shared Admin Test Helpers for Flash Arbitrage Contracts
 *
 * Provides reusable test suites for admin functions shared by all contracts
 * inheriting from BaseFlashArbitrage:
 * - Router management (add/remove/verify)
 * - setMinimumProfit
 * - setSwapDeadline
 * - setWithdrawGasLimit
 * - pause/unpause
 * - withdrawToken
 * - withdrawETH
 * - Ownable2Step (two-step ownership transfer)
 *
 * Usage:
 *   import { testRouterManagement, testPauseUnpause, ... } from './helpers/shared-admin-tests';
 *
 *   const adminConfig = {
 *     contractName: 'SyncSwapFlashArbitrage',
 *     getFixture: async () => {
 *       const f = await loadFixture(deployContractsFixture);
 *       return { contract: f.syncSwapArbitrage, owner: f.owner, user: f.user, ... };
 *     },
 *   };
 *
 *   testRouterManagement(adminConfig);
 *   testMinimumProfitConfig(adminConfig);
 *
 * @see contracts/src/base/BaseFlashArbitrage.sol
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';

// =============================================================================
// Types
// =============================================================================

export interface AdminTestFixture {
  /** The contract under test (any contract extending BaseFlashArbitrage) */
  contract: any;
  /** Owner signer (deployer) */
  owner: any;
  /** Non-owner signer (unauthorized user) */
  user: any;
  /** First mock DEX router */
  dexRouter1: any;
  /** Second mock DEX router */
  dexRouter2: any;
  /** WETH mock token (or primary ERC20 for withdrawal tests) */
  weth: any;
  /** Third signer for Ownable2Step tests (optional, falls back to ethers.getSigners()[3]) */
  attacker?: any;
}

export interface AdminTestConfig {
  /** Contract name for describe blocks */
  contractName: string;
  /** Returns a fresh fixture with normalized field names */
  getFixture: () => Promise<AdminTestFixture>;
  /** Default minimum profit set in constructor (defaults to 1e14) */
  defaultMinProfit?: bigint;
  /** Default swap deadline in seconds (defaults to 60) */
  defaultSwapDeadline?: number;
  /** Maximum allowed swap deadline (defaults to 600) */
  maxSwapDeadline?: number;
  /** Default withdraw gas limit (defaults to 50000) */
  defaultWithdrawGasLimit?: number;
  /** Minimum withdraw gas limit (defaults to 2300) */
  minWithdrawGasLimit?: number;
  /** Maximum withdraw gas limit (defaults to 500000) */
  maxWithdrawGasLimit?: number;
}

// =============================================================================
// Router Management Tests (~8 tests)
// =============================================================================

export function testRouterManagement(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;

  describe(`${contractName} — Router Management`, () => {
    it('should allow owner to add router', async () => {
      const { contract, dexRouter1, owner } = await getFixture();

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      expect(await contract.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
    });

    it('should emit RouterAdded event', async () => {
      const { contract, dexRouter1, owner } = await getFixture();

      await expect(
        contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress())
      )
        .to.emit(contract, 'RouterAdded')
        .withArgs(await dexRouter1.getAddress());
    });

    it('should allow multiple routers to be added', async () => {
      const { contract, dexRouter1, dexRouter2, owner } = await getFixture();

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await contract.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      expect((await contract.getApprovedRouters()).length).to.equal(2);
      expect(await contract.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
      expect(await contract.isApprovedRouter(await dexRouter2.getAddress())).to.be.true;
    });

    it('should remove router and emit RouterRemoved event', async () => {
      const { contract, dexRouter1, dexRouter2, owner } = await getFixture();

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await contract.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      await expect(
        contract.connect(owner).removeApprovedRouter(await dexRouter1.getAddress())
      )
        .to.emit(contract, 'RouterRemoved')
        .withArgs(await dexRouter1.getAddress());

      expect(await contract.isApprovedRouter(await dexRouter1.getAddress())).to.be.false;
      expect(await contract.isApprovedRouter(await dexRouter2.getAddress())).to.be.true;
    });

    it('should revert when adding zero address', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).addApprovedRouter(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(contract, 'InvalidRouterAddress');
    });

    it('should revert when adding already approved router', async () => {
      const { contract, dexRouter1, owner } = await getFixture();

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await expect(
        contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress())
      ).to.be.revertedWithCustomError(contract, 'RouterAlreadyApproved');
    });

    it('should revert when removing unapproved router', async () => {
      const { contract, dexRouter1, owner } = await getFixture();

      await expect(
        contract.connect(owner).removeApprovedRouter(await dexRouter1.getAddress())
      ).to.be.revertedWithCustomError(contract, 'RouterNotApproved');
    });

    it('should revert when non-owner manages routers', async () => {
      const { contract, dexRouter1, user } = await getFixture();

      await expect(
        contract.connect(user).addApprovedRouter(await dexRouter1.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
}

// =============================================================================
// setMinimumProfit Tests (~4 tests)
// =============================================================================

export function testMinimumProfitConfig(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;
  const defaultMinProfit = config.defaultMinProfit ?? BigInt(1e14);

  describe(`${contractName} — setMinimumProfit`, () => {
    it('should allow owner to update minimum profit', async () => {
      const { contract, owner } = await getFixture();

      const newMinProfit = ethers.parseEther('0.05');
      await contract.connect(owner).setMinimumProfit(newMinProfit);

      expect(await contract.minimumProfit()).to.equal(newMinProfit);
    });

    it('should emit MinimumProfitUpdated event', async () => {
      const { contract, owner } = await getFixture();

      const newMinProfit = ethers.parseEther('0.05');
      await expect(contract.connect(owner).setMinimumProfit(newMinProfit))
        .to.emit(contract, 'MinimumProfitUpdated')
        .withArgs(defaultMinProfit, newMinProfit);
    });

    it('should revert when setting minimum profit to zero', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).setMinimumProfit(0)
      ).to.be.revertedWithCustomError(contract, 'InvalidMinimumProfit');
    });

    it('should revert if non-owner tries to update', async () => {
      const { contract, user } = await getFixture();

      await expect(
        contract.connect(user).setMinimumProfit(ethers.parseEther('0.05'))
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
}

// =============================================================================
// setSwapDeadline Tests (~6 tests)
// =============================================================================

export function testSwapDeadlineConfig(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;
  const defaultSwapDeadline = config.defaultSwapDeadline ?? 60;
  const maxSwapDeadline = config.maxSwapDeadline ?? 600;

  describe(`${contractName} — setSwapDeadline`, () => {
    it('should initialize with default swap deadline', async () => {
      const { contract } = await getFixture();
      expect(await contract.swapDeadline()).to.equal(defaultSwapDeadline);
    });

    it('should allow owner to update swap deadline', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).setSwapDeadline(maxSwapDeadline);
      expect(await contract.swapDeadline()).to.equal(maxSwapDeadline);
    });

    it('should emit SwapDeadlineUpdated event', async () => {
      const { contract, owner } = await getFixture();

      await expect(contract.connect(owner).setSwapDeadline(300))
        .to.emit(contract, 'SwapDeadlineUpdated')
        .withArgs(defaultSwapDeadline, 300);
    });

    it('should revert on zero deadline', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).setSwapDeadline(0)
      ).to.be.revertedWithCustomError(contract, 'InvalidSwapDeadline');
    });

    it('should revert on deadline exceeding maximum', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).setSwapDeadline(maxSwapDeadline + 1)
      ).to.be.revertedWithCustomError(contract, 'InvalidSwapDeadline');
    });

    it('should revert if non-owner tries to update', async () => {
      const { contract, user } = await getFixture();

      await expect(
        contract.connect(user).setSwapDeadline(300)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
}

// =============================================================================
// Pause / Unpause Tests (~4 tests)
// =============================================================================

export function testPauseUnpause(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;

  describe(`${contractName} — pause / unpause`, () => {
    it('should allow owner to pause', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).pause();
      expect(await contract.paused()).to.be.true;
    });

    it('should allow owner to unpause', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).pause();
      await contract.connect(owner).unpause();
      expect(await contract.paused()).to.be.false;
    });

    it('should revert if non-owner tries to pause', async () => {
      const { contract, user } = await getFixture();

      await expect(
        contract.connect(user).pause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should revert if non-owner tries to unpause', async () => {
      const { contract, owner, user } = await getFixture();

      await contract.connect(owner).pause();

      await expect(
        contract.connect(user).unpause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
}

// =============================================================================
// withdrawToken Tests (~4 tests)
// =============================================================================

export function testWithdrawToken(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;

  describe(`${contractName} — withdrawToken`, () => {
    it('should allow owner to withdraw ERC20 tokens', async () => {
      const { contract, weth, owner } = await getFixture();

      await weth.mint(await contract.getAddress(), ethers.parseEther('1'));

      const ownerBalanceBefore = await weth.balanceOf(owner.address);

      await contract.connect(owner).withdrawToken(
        await weth.getAddress(),
        owner.address,
        ethers.parseEther('1')
      );

      const ownerBalanceAfter = await weth.balanceOf(owner.address);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther('1'));
    });

    it('should emit TokenWithdrawn event', async () => {
      const { contract, weth, owner } = await getFixture();

      await weth.mint(await contract.getAddress(), ethers.parseEther('1'));

      await expect(
        contract.connect(owner).withdrawToken(
          await weth.getAddress(),
          owner.address,
          ethers.parseEther('1')
        )
      )
        .to.emit(contract, 'TokenWithdrawn')
        .withArgs(await weth.getAddress(), owner.address, ethers.parseEther('1'));
    });

    it('should revert on zero address recipient', async () => {
      const { contract, weth, owner } = await getFixture();

      await weth.mint(await contract.getAddress(), ethers.parseEther('1'));

      await expect(
        contract.connect(owner).withdrawToken(
          await weth.getAddress(),
          ethers.ZeroAddress,
          ethers.parseEther('1')
        )
      ).to.be.revertedWithCustomError(contract, 'InvalidRecipient');
    });

    it('should revert if non-owner tries to withdraw', async () => {
      const { contract, weth, user } = await getFixture();

      await weth.mint(await contract.getAddress(), ethers.parseEther('1'));

      await expect(
        contract.connect(user).withdrawToken(
          await weth.getAddress(),
          user.address,
          ethers.parseEther('1')
        )
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
}

// =============================================================================
// withdrawETH Tests (~4 tests)
// =============================================================================

export function testWithdrawETH(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;

  describe(`${contractName} — withdrawETH`, () => {
    it('should allow owner to withdraw ETH', async () => {
      const { contract, owner } = await getFixture();

      await owner.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('1'),
      });

      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

      const tx = await contract.connect(owner).withdrawETH(
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

    it('should emit ETHWithdrawn event', async () => {
      const { contract, owner } = await getFixture();

      await owner.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('1'),
      });

      await expect(
        contract.connect(owner).withdrawETH(owner.address, ethers.parseEther('1'))
      )
        .to.emit(contract, 'ETHWithdrawn')
        .withArgs(owner.address, ethers.parseEther('1'));
    });

    it('should revert on zero address recipient', async () => {
      const { contract, owner } = await getFixture();

      await owner.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('1'),
      });

      await expect(
        contract.connect(owner).withdrawETH(ethers.ZeroAddress, ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(contract, 'InvalidRecipient');
    });

    it('should revert if non-owner tries to withdraw', async () => {
      const { contract, owner, user } = await getFixture();

      await owner.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('1'),
      });

      await expect(
        contract.connect(user).withdrawETH(user.address, ethers.parseEther('1'))
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
}

// =============================================================================
// setWithdrawGasLimit Tests (~7 tests)
// =============================================================================

export function testWithdrawGasLimitConfig(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;
  const defaultGasLimit = config.defaultWithdrawGasLimit ?? 50000;
  const minGasLimit = config.minWithdrawGasLimit ?? 2300;
  const maxGasLimit = config.maxWithdrawGasLimit ?? 500000;

  describe(`${contractName} — setWithdrawGasLimit`, () => {
    it('should initialize with default gas limit', async () => {
      const { contract } = await getFixture();
      expect(await contract.withdrawGasLimit()).to.equal(defaultGasLimit);
    });

    it('should set gas limit within valid range', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).setWithdrawGasLimit(100000);
      expect(await contract.withdrawGasLimit()).to.equal(100000);
    });

    it('should accept minimum value', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).setWithdrawGasLimit(minGasLimit);
      expect(await contract.withdrawGasLimit()).to.equal(minGasLimit);
    });

    it('should accept maximum value', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).setWithdrawGasLimit(maxGasLimit);
      expect(await contract.withdrawGasLimit()).to.equal(maxGasLimit);
    });

    it('should reject below minimum', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).setWithdrawGasLimit(minGasLimit - 1)
      ).to.be.revertedWithCustomError(contract, 'InvalidGasLimit');
    });

    it('should reject above maximum', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).setWithdrawGasLimit(maxGasLimit + 1)
      ).to.be.revertedWithCustomError(contract, 'InvalidGasLimit');
    });

    it('should emit WithdrawGasLimitUpdated event', async () => {
      const { contract, owner } = await getFixture();

      await expect(contract.connect(owner).setWithdrawGasLimit(100000))
        .to.emit(contract, 'WithdrawGasLimitUpdated')
        .withArgs(defaultGasLimit, 100000);
    });

    it('should revert when called by non-owner', async () => {
      const { contract, user } = await getFixture();

      await expect(
        contract.connect(user).setWithdrawGasLimit(100000)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });
}

// =============================================================================
// Ownable2Step Tests (~2 tests)
// =============================================================================

export function testOwnable2Step(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;

  describe(`${contractName} — Ownable2Step`, () => {
    it('should support two-step ownership transfer', async () => {
      const { contract, owner, user } = await getFixture();

      await contract.connect(owner).transferOwnership(user.address);

      expect(await contract.owner()).to.equal(owner.address);
      expect(await contract.pendingOwner()).to.equal(user.address);

      await contract.connect(user).acceptOwnership();

      expect(await contract.owner()).to.equal(user.address);
    });

    it('should not allow non-pending owner to accept', async () => {
      const { contract, owner, user, attacker } = await getFixture();

      // Use attacker if provided, otherwise get a third signer
      const thirdParty = attacker ?? (await ethers.getSigners())[3];

      await contract.connect(owner).transferOwnership(user.address);

      await expect(
        contract.connect(thirdParty).acceptOwnership()
      ).to.be.revertedWith('Ownable2Step: caller is not the new owner');
    });
  });
}

// =============================================================================
// Convenience: Run All Admin Tests
// =============================================================================

export function testAllAdminFunctions(config: AdminTestConfig): void {
  testRouterManagement(config);
  testMinimumProfitConfig(config);
  testSwapDeadlineConfig(config);
  testPauseUnpause(config);
  testWithdrawToken(config);
  testWithdrawETH(config);
  testWithdrawGasLimitConfig(config);
  testOwnable2Step(config);
}
