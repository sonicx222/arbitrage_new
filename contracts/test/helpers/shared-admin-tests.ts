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
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { MockDexRouter, MockERC20 } from '../../typechain-types';

// =============================================================================
// Types (M-02: typed fixtures replacing `any`)
// =============================================================================

export interface AdminTestFixture {
  /** The contract under test (any contract extending BaseFlashArbitrage) */
  contract: any; // Protocol-specific — kept generic for 7-contract reuse
  /** Owner signer (deployer) */
  owner: SignerWithAddress;
  /** Non-owner signer (unauthorized user) */
  user: SignerWithAddress;
  /** First mock DEX router */
  dexRouter1: MockDexRouter;
  /** Second mock DEX router */
  dexRouter2: MockDexRouter;
  /** WETH mock token (or primary ERC20 for withdrawal tests) */
  weth: MockERC20;
  /** Third signer for Ownable2Step tests (optional, falls back to ethers.getSigners()[3]) */
  attacker?: SignerWithAddress;
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
// M-10: Admin Test Config Factory
// =============================================================================

/**
 * Creates an AdminTestConfig from a deployment fixture, reducing boilerplate
 * across the 6 protocol test files that all share the same admin test structure.
 *
 * @param contractName - Contract name for describe blocks
 * @param deployFixture - The test file's deployContractsFixture function
 * @param getContract - Extracts the contract under test from the fixture
 */
export function createAdminTestConfig(
  contractName: string,
  deployFixture: () => Promise<any>,
  getContract: (fixture: any) => any,
): AdminTestConfig {
  return {
    contractName,
    getFixture: async () => {
      const f = await loadFixture(deployFixture);
      return {
        contract: getContract(f),
        owner: f.owner,
        user: f.user,
        attacker: f.attacker,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
      };
    },
  };
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

    it('should accept type(uint256).max as minimum profit (M-05)', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).setMinimumProfit(ethers.MaxUint256);
      expect(await contract.minimumProfit()).to.equal(ethers.MaxUint256);
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

      await contract.connect(owner).setSwapDeadline(300);
      expect(await contract.swapDeadline()).to.equal(300);
    });

    it('should accept exactly MAX_SWAP_DEADLINE (boundary)', async () => {
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

    it('should revert on type(uint256).max deadline (M-05)', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).setSwapDeadline(ethers.MaxUint256)
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

    it('should emit Paused event with owner address (L-10)', async () => {
      const { contract, owner } = await getFixture();

      await expect(contract.connect(owner).pause())
        .to.emit(contract, 'Paused')
        .withArgs(owner.address);
    });

    it('should allow owner to unpause', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).pause();
      await contract.connect(owner).unpause();
      expect(await contract.paused()).to.be.false;
    });

    it('should emit Unpaused event with owner address (L-10)', async () => {
      const { contract, owner } = await getFixture();

      await contract.connect(owner).pause();
      await expect(contract.connect(owner).unpause())
        .to.emit(contract, 'Unpaused')
        .withArgs(owner.address);
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

    it('should allow owner to withdraw tokens while paused (M-06 regression)', async () => {
      const { contract, weth, owner } = await getFixture();

      await weth.mint(await contract.getAddress(), ethers.parseEther('1'));
      await contract.connect(owner).pause();

      // Withdrawal must succeed while paused (emergency fund recovery)
      await contract.connect(owner).withdrawToken(
        await weth.getAddress(),
        owner.address,
        ethers.parseEther('1')
      );

      const contractBalance = await weth.balanceOf(await contract.getAddress());
      expect(contractBalance).to.equal(0);
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

    it('should allow owner to withdraw ETH while paused (M-06 regression)', async () => {
      const { contract, owner } = await getFixture();

      await owner.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('1'),
      });
      await contract.connect(owner).pause();

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

    it('should succeed with gas-heavy recipient at default limit, fail at 2300 (L-02)', async () => {
      const { contract, owner } = await getFixture();

      await owner.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('2'),
      });

      // Deploy a contract whose receive() does SSTORE (requires >2300 gas)
      const GasHeavy = await ethers.getContractFactory('MockGasHeavyReceiver');
      const receiver = await GasHeavy.deploy();

      // Default gas limit (50000) should succeed
      await contract.connect(owner).withdrawETH(await receiver.getAddress(), ethers.parseEther('1'));
      expect(await receiver.receiveCount()).to.equal(1);

      // Set gas limit to 2300 (minimum) — receiver needs >2300 for SSTORE, so it should fail
      await contract.connect(owner).setWithdrawGasLimit(2300);
      await expect(
        contract.connect(owner).withdrawETH(await receiver.getAddress(), ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(contract, 'ETHTransferFailed');
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

    it('should reject type(uint256).max gas limit (M-05)', async () => {
      const { contract, owner } = await getFixture();

      await expect(
        contract.connect(owner).setWithdrawGasLimit(ethers.MaxUint256)
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
// M-10: Zero-Amount Edge Case Tests (~3 tests)
// =============================================================================

export function testZeroAmountEdgeCases(config: AdminTestConfig): void {
  const { contractName, getFixture } = config;

  describe(`${contractName} — Zero-Amount Edge Cases (M-10)`, () => {
    it('should allow withdrawToken with zero amount (no-op transfer)', async () => {
      const { contract, weth, owner } = await getFixture();

      // Fund the contract with some tokens
      await weth.mint(await contract.getAddress(), ethers.parseEther('1'));

      const ownerBalanceBefore = await weth.balanceOf(owner.address);

      // Zero-amount withdraw should succeed (ERC20 safeTransfer allows 0)
      await contract.connect(owner).withdrawToken(
        await weth.getAddress(),
        owner.address,
        0
      );

      const ownerBalanceAfter = await weth.balanceOf(owner.address);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore); // No change
    });

    it('should allow withdrawETH with zero amount (no-op transfer)', async () => {
      const { contract, owner } = await getFixture();

      // Fund contract with ETH
      await owner.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('1'),
      });

      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

      // Zero-amount ETH withdraw should succeed
      const tx = await contract.connect(owner).withdrawETH(owner.address, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * BigInt(receipt!.gasPrice ?? 0);

      const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
      // Only change should be gas cost
      expect(ownerBalanceAfter).to.be.closeTo(
        ownerBalanceBefore - gasUsed,
        ethers.parseEther('0.001')
      );
    });

    it('should reject setWithdrawGasLimit(0) with InvalidGasLimit', async () => {
      const { contract, owner } = await getFixture();

      // 0 is below the minimum of 2300
      await expect(
        contract.connect(owner).setWithdrawGasLimit(0)
      ).to.be.revertedWithCustomError(contract, 'InvalidGasLimit');
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
