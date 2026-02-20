import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { BalancerV2FlashArbitrage, MockDexRouter, MockERC20, MockBalancerVault } from '../typechain-types';
import {
  deployBaseFixture,
  fundProvider,
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  getDeadline,
} from './helpers';

/**
 * BalancerV2FlashArbitrage - Callback, Profit, Admin & Security Tests
 *
 * Split from BalancerV2FlashArbitrage.test.ts for maintainability.
 * Tests:
 * - Flash loan callback (receiveFlashLoan)
 * - Profit validation
 * - Configuration management (minimumProfit, swapDeadline, pause)
 * - Fund recovery (withdrawToken, withdrawETH)
 * - Access control (Ownable2Step, ReentrancyGuard)
 * - View functions (calculateExpectedProfit)
 * - Edge cases and security
 * - Gas benchmarks
 *
 * @see BalancerV2FlashArbitrage.test.ts for deployment, router, flash loan, and swap tests
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */
describe('BalancerV2FlashArbitrage Callback & Admin', () => {
  async function deployContractsFixture() {
    const BALANCER_AMOUNTS = {
      wethPerRouter: ethers.parseEther('10000'),
      usdcPerRouter: ethers.parseUnits('10000000', 6),
      daiPerRouter: ethers.parseEther('10000000'),
    };
    const base = await deployBaseFixture(BALANCER_AMOUNTS);

    const MockBalancerVaultFactory = await ethers.getContractFactory('MockBalancerVault');
    const vault = await MockBalancerVaultFactory.deploy();
    await fundProvider(base, await vault.getAddress(), BALANCER_AMOUNTS);

    const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory('BalancerV2FlashArbitrage');
    const arbitrage = await BalancerV2FlashArbitrageFactory.deploy(
      await vault.getAddress(),
      base.owner.address
    );

    return { arbitrage, vault, ...base };
  }

  // ===========================================================================
  // 5. Flash Loan Callback Tests
  // ===========================================================================
  describe('5. Flash Loan Callback (receiveFlashLoan)', () => {
    it('should only accept calls from vault', async () => {
      const { arbitrage, weth, attacker } = await loadFixture(deployContractsFixture);

      const tokens = [await weth.getAddress()];
      const amounts = [ethers.parseEther('10')];
      const feeAmounts = [0];
      const userData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
        [[], 0]
      );

      await expect(
        arbitrage.connect(attacker).receiveFlashLoan(tokens, amounts, feeAmounts, userData)
      ).to.be.revertedWithCustomError(arbitrage, 'InvalidFlashLoanCaller');
    });

    it('should revert when receiveFlashLoan is called without active flash loan context', async () => {
      const { arbitrage, vault, weth, usdc, owner } = await loadFixture(deployContractsFixture);

      // The callback has two security layers:
      // 1. msg.sender must be the vault
      // 2. _flashLoanActive must be true (set during executeArbitrage)
      //
      // We impersonate the vault to bypass layer 1 and verify layer 2 catches direct calls.
      // This also demonstrates the multi-asset scenario: even if someone could call
      // receiveFlashLoan with 2 tokens from the vault, the _flashLoanActive guard rejects it.

      const vaultAddress = await vault.getAddress();

      // Impersonate the vault to call receiveFlashLoan directly
      await ethers.provider.send('hardhat_impersonateAccount', [vaultAddress]);
      await owner.sendTransaction({ to: vaultAddress, value: ethers.parseEther('1') });
      const vaultSigner = await ethers.getSigner(vaultAddress);

      const userData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
        [[], 0]
      );

      // Calling from vault address but without _flashLoanActive set triggers FlashLoanNotActive.
      // The _flashLoanActive guard (defense in depth) runs before the multi-asset check.
      await expect(
        arbitrage.connect(vaultSigner).receiveFlashLoan(
          [await weth.getAddress(), await usdc.getAddress()],
          [ethers.parseEther('10'), ethers.parseUnits('10000', 6)],
          [0, 0],
          userData
        )
      ).to.be.revertedWithCustomError(arbitrage, 'FlashLoanNotActive');

      await ethers.provider.send('hardhat_stopImpersonatingAccount', [vaultAddress]);
    });

    it('should revert with MultiAssetNotSupported when multiple tokens are provided', async () => {
      const { arbitrage, vault, weth, usdc, owner } = await loadFixture(deployContractsFixture);

      // To reach the MultiAssetNotSupported check, we need _flashLoanActive = true.
      // The _flashLoanActive guard (FlashLoanNotActive) runs before the multi-asset check.
      // We use hardhat_setStorageAt to force _flashLoanActive = true in storage.
      //
      // Storage layout for BalancerV2FlashArbitrage (verified empirically):
      // Slot 0: Ownable._owner (address)
      // Slot 1: Ownable2Step._pendingOwner (address) + Pausable._paused (bool, packed)
      // Slot 2: ReentrancyGuard._status (uint256, initialized to 1)
      // Slot 3: BaseFlashArbitrage.minimumProfit
      // Slot 4: BaseFlashArbitrage.totalProfits
      // Slot 5: BaseFlashArbitrage.tokenProfits (mapping)
      // Slot 6: BaseFlashArbitrage.swapDeadline (= 60)
      // Slot 7: BaseFlashArbitrage.withdrawGasLimit (= 50000)
      // Slot 8: BaseFlashArbitrage._approvedRouters._inner._values (array length)
      // Slot 9: BaseFlashArbitrage._approvedRouters._inner._indexes (mapping)
      // Slot 10: BalancerV2FlashArbitrage._flashLoanActive (bool)
      const arbitrageAddress = await arbitrage.getAddress();
      const flashLoanActiveSlot = 10;

      // Set _flashLoanActive = true
      await ethers.provider.send('hardhat_setStorageAt', [
        arbitrageAddress,
        ethers.toBeHex(flashLoanActiveSlot, 32),
        ethers.toBeHex(1, 32), // true = 1
      ]);

      // Impersonate the vault to call receiveFlashLoan directly
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send('hardhat_impersonateAccount', [vaultAddress]);
      await owner.sendTransaction({ to: vaultAddress, value: ethers.parseEther('1') });
      const vaultSigner = await ethers.getSigner(vaultAddress);

      const userData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
        [[], 0]
      );

      // Call receiveFlashLoan with 2 tokens to trigger MultiAssetNotSupported
      await expect(
        arbitrage.connect(vaultSigner).receiveFlashLoan(
          [await weth.getAddress(), await usdc.getAddress()],
          [ethers.parseEther('10'), ethers.parseUnits('10000', 6)],
          [0, 0],
          userData
        )
      ).to.be.revertedWithCustomError(arbitrage, 'MultiAssetNotSupported');

      await ethers.provider.send('hardhat_stopImpersonatingAccount', [vaultAddress]);

      // Reset _flashLoanActive to false for clean state
      await ethers.provider.send('hardhat_setStorageAt', [
        arbitrageAddress,
        ethers.toBeHex(flashLoanActiveSlot, 32),
        ethers.toBeHex(0, 32),
      ]);
    });

    it('should repay flash loan correctly', async () => {
      const { arbitrage, vault, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

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

      const vaultBalanceBefore = await weth.balanceOf(await vault.getAddress());

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

      const vaultBalanceAfter = await weth.balanceOf(await vault.getAddress());

      // Vault should have same or more (it gets repaid exactly)
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore);
    });
  });

  // ===========================================================================
  // 6. Profit Validation Tests
  // ===========================================================================
  describe('6. Profit Validation', () => {
    it('should revert on insufficient profit (below minProfit param)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set rates that give minimal profit
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('500500000000000000000000000') // Barely profitable
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

      // Require huge profit
      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath,
          ethers.parseEther('5'), // Require 5 WETH profit (impossible)
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'InsufficientProfit');
    });

    it('should revert on insufficient profit (below minimumProfit setting)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await arbitrage.connect(owner).setMinimumProfit(ethers.parseEther('5'));

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

    it('should use max of minProfit and minimumProfit', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await arbitrage.connect(owner).setMinimumProfit(ethers.parseEther('0.01'));

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

      // Should succeed since profit > max(0.05, 0.01)
      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        ethers.parseEther('0.05'),
        deadline
      );

      expect(await weth.balanceOf(await arbitrage.getAddress())).to.be.gt(0);
    });

    it('should revert on unprofitable trade', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set rates that cause loss
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('490000000000000000000000000') // Results in loss
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
          amountOutMin: ethers.parseEther('8'), // Low minimum to allow swap
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
      ).to.be.revertedWithCustomError(arbitrage, 'InsufficientProfit');
    });
  });

  // ===========================================================================
  // 7. Configuration Management Tests
  // ===========================================================================
  describe('7. Configuration Management', () => {
    describe('setMinimumProfit()', () => {
      it('should allow owner to set minimum profit', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        const newMinProfit = ethers.parseEther('0.1');
        await arbitrage.connect(owner).setMinimumProfit(newMinProfit);

        expect(await arbitrage.minimumProfit()).to.equal(newMinProfit);
      });

      it('should emit MinimumProfitUpdated event', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        const newMinProfit = ethers.parseEther('0.1');
        await expect(arbitrage.connect(owner).setMinimumProfit(newMinProfit))
          .to.emit(arbitrage, 'MinimumProfitUpdated')
          .withArgs(BigInt(1e14), newMinProfit);
      });

      it('should revert when setting to zero', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(owner).setMinimumProfit(0)
        ).to.be.revertedWithCustomError(arbitrage, 'InvalidMinimumProfit');
      });

      it('should revert if non-owner tries to set', async () => {
        const { arbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(user).setMinimumProfit(ethers.parseEther('0.1'))
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('setSwapDeadline()', () => {
      it('should allow owner to set swap deadline', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        const newDeadline = 300;
        await arbitrage.connect(owner).setSwapDeadline(newDeadline);

        expect(await arbitrage.swapDeadline()).to.equal(newDeadline);
      });

      it('should emit SwapDeadlineUpdated event', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        const newDeadline = 300;
        await expect(arbitrage.connect(owner).setSwapDeadline(newDeadline))
          .to.emit(arbitrage, 'SwapDeadlineUpdated')
          .withArgs(60, newDeadline);
      });

      it('should revert on zero deadline', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(owner).setSwapDeadline(0)
        ).to.be.revertedWithCustomError(arbitrage, 'InvalidSwapDeadline');
      });

      it('should revert on deadline exceeding MAX_SWAP_DEADLINE', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(owner).setSwapDeadline(601) // > 600
        ).to.be.revertedWithCustomError(arbitrage, 'InvalidSwapDeadline');
      });

      it('should accept MAX_SWAP_DEADLINE exactly', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).setSwapDeadline(600);
        expect(await arbitrage.swapDeadline()).to.equal(600);
      });

      it('should revert if non-owner tries to set', async () => {
        const { arbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(user).setSwapDeadline(600)
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('pause() / unpause()', () => {
      it('should allow owner to pause', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).pause();
        expect(await arbitrage.paused()).to.be.true;
      });

      it('should allow owner to unpause', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).pause();
        await arbitrage.connect(owner).unpause();
        expect(await arbitrage.paused()).to.be.false;
      });

      it('should revert if non-owner tries to pause', async () => {
        const { arbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(user).pause()
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should revert if non-owner tries to unpause', async () => {
        const { arbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).pause();

        await expect(
          arbitrage.connect(user).unpause()
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });
  });

  // ===========================================================================
  // 8. Fund Recovery Tests
  // ===========================================================================
  describe('8. Fund Recovery', () => {
    describe('withdrawToken()', () => {
      it('should allow owner to withdraw ERC20 tokens', async () => {
        const { arbitrage, weth, owner } = await loadFixture(deployContractsFixture);

        // Send tokens to contract
        await weth.mint(await arbitrage.getAddress(), ethers.parseEther('10'));

        const ownerBalanceBefore = await weth.balanceOf(owner.address);

        await arbitrage.connect(owner).withdrawToken(
          await weth.getAddress(),
          owner.address,
          ethers.parseEther('10')
        );

        const ownerBalanceAfter = await weth.balanceOf(owner.address);
        expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther('10'));
      });

      it('should emit TokenWithdrawn event', async () => {
        const { arbitrage, weth, owner } = await loadFixture(deployContractsFixture);

        await weth.mint(await arbitrage.getAddress(), ethers.parseEther('10'));

        await expect(
          arbitrage.connect(owner).withdrawToken(
            await weth.getAddress(),
            owner.address,
            ethers.parseEther('10')
          )
        )
          .to.emit(arbitrage, 'TokenWithdrawn')
          .withArgs(await weth.getAddress(), owner.address, ethers.parseEther('10'));
      });

      it('should revert on zero recipient address', async () => {
        const { arbitrage, weth, owner } = await loadFixture(deployContractsFixture);

        await weth.mint(await arbitrage.getAddress(), ethers.parseEther('10'));

        await expect(
          arbitrage.connect(owner).withdrawToken(
            await weth.getAddress(),
            ethers.ZeroAddress,
            ethers.parseEther('10')
          )
        ).to.be.revertedWithCustomError(arbitrage, 'InvalidRecipient');
      });

      it('should revert if non-owner tries to withdraw', async () => {
        const { arbitrage, weth, user } = await loadFixture(deployContractsFixture);

        await weth.mint(await arbitrage.getAddress(), ethers.parseEther('10'));

        await expect(
          arbitrage.connect(user).withdrawToken(
            await weth.getAddress(),
            user.address,
            ethers.parseEther('10')
          )
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('withdrawETH()', () => {
      it('should allow owner to withdraw ETH', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        // Send ETH to contract
        await owner.sendTransaction({
          to: await arbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

        const tx = await arbitrage.connect(owner).withdrawETH(
          owner.address,
          ethers.parseEther('1')
        );
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * BigInt(receipt!.gasPrice ?? 0);

        const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
        expect(ownerBalanceAfter).to.be.closeTo(
          ownerBalanceBefore + ethers.parseEther('1') - gasUsed,
          ethers.parseEther('0.001')
        );
      });

      it('should emit ETHWithdrawn event', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await owner.sendTransaction({
          to: await arbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        await expect(
          arbitrage.connect(owner).withdrawETH(owner.address, ethers.parseEther('1'))
        )
          .to.emit(arbitrage, 'ETHWithdrawn')
          .withArgs(owner.address, ethers.parseEther('1'));
      });

      it('should revert on zero recipient address', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await owner.sendTransaction({
          to: await arbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        await expect(
          arbitrage.connect(owner).withdrawETH(ethers.ZeroAddress, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(arbitrage, 'InvalidRecipient');
      });

      it('should revert if non-owner tries to withdraw ETH', async () => {
        const { arbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await owner.sendTransaction({
          to: await arbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        await expect(
          arbitrage.connect(user).withdrawETH(user.address, ethers.parseEther('1'))
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should revert ETH withdrawal to rejecting contract (Fix 8f)', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        // Fund the arbitrage contract with ETH
        await owner.sendTransaction({
          to: await arbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        // Deploy a contract that rejects ETH (MockERC20 has no receive/fallback)
        // The gas-limited call (10000 gas) should fail if the recipient reverts
        const RejectEther = await ethers.getContractFactory('MockERC20');
        const rejecter = await RejectEther.deploy('Rejector', 'REJ', 18);

        await expect(
          arbitrage.connect(owner).withdrawETH(await rejecter.getAddress(), ethers.parseEther('0.5'))
        ).to.be.revertedWithCustomError(arbitrage, 'ETHTransferFailed');
      });
    });
  });

  // ===========================================================================
  // 9. Access Control Tests
  // ===========================================================================
  describe('9. Access Control', () => {
    describe('Ownable2Step', () => {
      it('should support two-step ownership transfer', async () => {
        const { arbitrage, owner, user } = await loadFixture(deployContractsFixture);

        // Step 1: Initiate transfer
        await arbitrage.connect(owner).transferOwnership(user.address);
        expect(await arbitrage.owner()).to.equal(owner.address);
        expect(await arbitrage.pendingOwner()).to.equal(user.address);

        // Step 2: Accept ownership
        await arbitrage.connect(user).acceptOwnership();
        expect(await arbitrage.owner()).to.equal(user.address);
      });

      it('should not allow non-pending owner to accept', async () => {
        const { arbitrage, owner, user, attacker } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).transferOwnership(user.address);

        await expect(
          arbitrage.connect(attacker).acceptOwnership()
        ).to.be.revertedWith('Ownable2Step: caller is not the new owner');
      });
    });

    describe('ReentrancyGuard', () => {
      it('should prevent reentrancy attacks via malicious router', async () => {
        const { arbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

        // Deploy malicious router targeting this contract
        const MaliciousRouterFactory = await ethers.getContractFactory('MockMaliciousRouter');
        const maliciousRouter = await MaliciousRouterFactory.deploy(
          await arbitrage.getAddress()
        );

        await arbitrage.connect(owner).addApprovedRouter(await maliciousRouter.getAddress());
        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Fund the malicious router with enough of each token (it does 1:1 passthrough in raw units)
        await weth.mint(await maliciousRouter.getAddress(), ethers.parseEther('1000'));
        await usdc.mint(await maliciousRouter.getAddress(), ethers.parseEther('1000'));

        // Set favorable exchange rate on dexRouter1 for the 2nd hop to generate profit.
        // The malicious router does 1:1 passthrough (amountOut = amountIn), which yields
        // zero profit. Using a normal router for the 2nd hop with a 1% premium ensures
        // the trade is profitable, so the tx succeeds and attackAttempted state persists.
        await dexRouter1.setExchangeRate(
          await usdc.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('1.01')
        );

        // Swap path: hop 1 through malicious router (triggers reentrancy),
        // hop 2 through normal router (generates profit)
        const swapPath = [
          {
            router: await maliciousRouter.getAddress(),
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

        // The malicious router attempts reentrancy during the first swap.
        // ReentrancyGuard blocks it (attackSucceeded=false), but the swap itself
        // continues. The tx succeeds because the trade is profitable.
        await arbitrage.executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        );

        // Verify the attack was actually attempted and blocked
        expect(await maliciousRouter.attackAttempted()).to.be.true;
        expect(await maliciousRouter.attackSucceeded()).to.be.false;
      });
    });
  });

  // ===========================================================================
  // 10. View Function Tests
  // ===========================================================================
  describe('10. View Functions', () => {
    describe('calculateExpectedProfit()', () => {
      it('should calculate expected profit correctly', async () => {
        const { arbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

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
            amountOutMin: 0,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0,
          },
        ];

        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.expectedProfit).to.be.gt(0);
        expect(result.flashLoanFee).to.equal(0); // Balancer V2 has 0% fees
      });

      it('should return zero flash loan fee', async () => {
        const { arbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

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
            amountOutMin: 0,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0,
          },
        ];

        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.flashLoanFee).to.equal(0);
      });

      it('should return 0 profit for empty path', async () => {
        const { arbitrage, weth } = await loadFixture(deployContractsFixture);

        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          []
        );

        expect(result.expectedProfit).to.equal(0);
        expect(result.flashLoanFee).to.equal(0);
      });

      it('should return 0 profit for invalid path (wrong start asset)', async () => {
        const { arbitrage, dexRouter1, weth, usdc } = await loadFixture(deployContractsFixture);

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(), // Wrong!
            tokenOut: await weth.getAddress(),
            amountOutMin: 0,
          },
        ];

        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.expectedProfit).to.equal(0);
      });

      it('should return 0 profit for invalid path (wrong end asset)', async () => {
        const { arbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await usdc.getAddress(),
          ethers.parseUnits('2000', 6)
        );

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(), // Ends with USDC, not WETH
            amountOutMin: 0,
          },
        ];

        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.expectedProfit).to.equal(0);
      });

      it('should return 0 profit for unprofitable trade', async () => {
        const { arbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Set rates that cause loss
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await usdc.getAddress(),
          ethers.parseUnits('2000', 6)
        );
        await dexRouter1.setExchangeRate(
          await usdc.getAddress(),
          await weth.getAddress(),
          BigInt('490000000000000000000000000') // Loss
        );

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 0,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0,
          },
        ];

        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.expectedProfit).to.equal(0);
      });

      it('should handle router call failures gracefully', async () => {
        const { arbitrage, weth, usdc } = await loadFixture(deployContractsFixture);

        // Use a deployed contract that doesn't implement IDexRouter.
        // A random no-code address can cause ABI decode failures that bypass try/catch.
        // Using weth (deployed MockERC20) ensures the call reverts due to missing
        // function selector, which is properly caught by the try/catch in _simulateSwapPath.
        const swapPath = [
          {
            router: await weth.getAddress(), // Deployed contract, but not a DEX router
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 0,
          },
          {
            router: await weth.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0,
          },
        ];

        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.expectedProfit).to.equal(0);
      });

      it('should detect inefficient cycles in swap path (Fix 8e)', async () => {
        const { arbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Set exchange rates
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

        // Create a path with an inefficient cycle: WETH→USDC→WETH→USDC→WETH
        // The intermediate WETH appears twice before the final step, indicating a cycle
        const cyclicSwapPath = [
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

        // _simulateSwapPath should detect the cycle and return 0
        const result = await arbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          cyclicSwapPath
        );

        expect(result.expectedProfit).to.equal(0);
      });
    });
  });

  // ===========================================================================
  // 11. Edge Cases and Security Tests
  // ===========================================================================
  describe('11. Edge Cases and Security', () => {
    it('should handle same router used multiple times in path', async () => {
      const { arbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // All swaps use same router
      await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
      await dexRouter1.setExchangeRate(await usdc.getAddress(), await dai.getAddress(), BigInt('1010000000000000000000000000000'));
      await dexRouter1.setExchangeRate(await dai.getAddress(), await weth.getAddress(), BigInt('510000000000000'));

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
          router: await dexRouter1.getAddress(),
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

    it('should handle very large profit amounts', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set rates that give huge profit
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('600000000000000000000000000') // 20% profit
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
          amountOutMin: ethers.parseEther('9'),
        },
      ];

      const deadline = await getDeadline();

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('100'),
        swapPath,
        0,
        deadline
      );

      const profit = await weth.balanceOf(await arbitrage.getAddress());
      expect(profit).to.be.gt(ethers.parseEther('10'));
    });

    it('should handle minimum slippage correctly', async () => {
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
          amountOutMin: 1, // Minimum non-zero
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1, // Minimum non-zero
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

    it('should receive ETH via receive function', async () => {
      const { arbitrage, owner } = await loadFixture(deployContractsFixture);

      await owner.sendTransaction({
        to: await arbitrage.getAddress(),
        value: ethers.parseEther('1'),
      });

      const balance = await ethers.provider.getBalance(await arbitrage.getAddress());
      expect(balance).to.equal(ethers.parseEther('1'));
    });

    it('should maintain consistent state across multiple arbitrages', async () => {
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

      // Execute first arbitrage
      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );

      const profitAfterFirst = await weth.balanceOf(await arbitrage.getAddress());
      const totalProfitsAfterFirst = await arbitrage.totalProfits();

      // Execute second arbitrage
      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline + 100
      );

      const profitAfterSecond = await weth.balanceOf(await arbitrage.getAddress());
      const totalProfitsAfterSecond = await arbitrage.totalProfits();

      // Verify profits accumulated
      expect(profitAfterSecond).to.be.gt(profitAfterFirst);
      expect(totalProfitsAfterSecond).to.be.gt(totalProfitsAfterFirst);
    });
  });

  // ===========================================================================
  // 12. Gas Benchmark Tests
  // ===========================================================================
  describe('12. Gas Benchmarks', () => {
    it('should execute 2-hop arbitrage within gas budget', async () => {
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

      const tx = await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );
      const receipt = await tx.wait();

      // Balancer V2 flash loan (0% fee) + 2 swaps should be < 500,000 gas
      expect(receipt!.gasUsed).to.be.lt(500_000);
    });
  });
});
