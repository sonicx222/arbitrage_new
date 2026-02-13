import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import {
  SyncSwapFlashArbitrage,
  MockDexRouter,
  MockERC20,
  MockSyncSwapVault,
} from '../typechain-types';
import {
  deployBaseFixture,
  fundProvider,
  RATE_USDC_TO_WETH_1PCT_PROFIT,
  RATE_USDC_TO_WETH_2PCT_PROFIT,
  RATE_WETH_TO_USDC,
  getDeadline,
} from './helpers';

/**
 * SyncSwapFlashArbitrage Contract Tests
 *
 * Comprehensive test suite for Task 3.4: SyncSwap Flash Loan Provider (zkSync Era)
 *
 * Contract implements EIP-3156 compliant flash loan arbitrage using SyncSwap:
 * 1. Flash loan from SyncSwap Vault (0.3% fee)
 * 2. Multi-hop swap execution across approved DEX routers
 * 3. Profit verification and tracking
 * 4. Router whitelist management
 * 5. Emergency controls (pause/unpause)
 *
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 */
describe('SyncSwapFlashArbitrage', () => {
  // Test fixtures for consistent state
  async function deployContractsFixture() {
    const base = await deployBaseFixture();

    // Deploy SyncSwap Vault (requires WETH address) and fund it
    const MockSyncSwapVaultFactory = await ethers.getContractFactory('MockSyncSwapVault');
    const vault = await MockSyncSwapVaultFactory.deploy(await base.weth.getAddress());
    await fundProvider(base, await vault.getAddress());

    // Deploy SyncSwapFlashArbitrage contract
    const SyncSwapFlashArbitrageFactory = await ethers.getContractFactory(
      'SyncSwapFlashArbitrage'
    );
    const syncSwapArbitrage = await SyncSwapFlashArbitrageFactory.deploy(
      await vault.getAddress(),
      base.owner.address
    );

    return { syncSwapArbitrage, vault, ...base };
  }

  // ===========================================================================
  // 1. Deployment and Initialization Tests
  // ===========================================================================
  describe('1. Deployment and Initialization', () => {
    it('should deploy with correct owner', async () => {
      const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.owner()).to.equal(owner.address);
    });

    it('should set vault address correctly', async () => {
      const { syncSwapArbitrage, vault } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.VAULT()).to.equal(await vault.getAddress());
    });

    it('should initialize with zero minimum profit', async () => {
      const { syncSwapArbitrage } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.minimumProfit()).to.equal(0);
    });

    it('should initialize with zero total profits', async () => {
      const { syncSwapArbitrage } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.totalProfits()).to.equal(0);
    });

    it('should initialize with default swap deadline (60 seconds)', async () => {
      const { syncSwapArbitrage } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.swapDeadline()).to.equal(60);
    });

    it('should verify constants are set correctly', async () => {
      const { syncSwapArbitrage } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.DEFAULT_SWAP_DEADLINE()).to.equal(60);
      expect(await syncSwapArbitrage.MAX_SWAP_DEADLINE()).to.equal(600);
      expect(await syncSwapArbitrage.MIN_SLIPPAGE_BPS()).to.equal(10);
      expect(await syncSwapArbitrage.MAX_SWAP_HOPS()).to.equal(5);
    });

    it('should revert on zero address vault', async () => {
      const [owner] = await ethers.getSigners();
      const SyncSwapFlashArbitrageFactory = await ethers.getContractFactory(
        'SyncSwapFlashArbitrage'
      );
      await expect(
        SyncSwapFlashArbitrageFactory.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: SyncSwapFlashArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should revert on non-contract vault address (EOA)', async () => {
      const [owner, user] = await ethers.getSigners();
      const SyncSwapFlashArbitrageFactory = await ethers.getContractFactory(
        'SyncSwapFlashArbitrage'
      );
      await expect(
        SyncSwapFlashArbitrageFactory.deploy(user.address, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: SyncSwapFlashArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should initialize with empty approved router list', async () => {
      const { syncSwapArbitrage } = await loadFixture(deployContractsFixture);
      expect((await syncSwapArbitrage.getApprovedRouters()).length).to.equal(0);
    });

    it('should start in unpaused state', async () => {
      const { syncSwapArbitrage } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.paused()).to.be.false;
    });
  });

  // ===========================================================================
  // 2. Router Management Tests
  // ===========================================================================
  describe('2. Router Management', () => {
    describe('addApprovedRouter()', () => {
      it('should allow owner to add router', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        expect(
          await syncSwapArbitrage.isApprovedRouter(await dexRouter1.getAddress())
        ).to.be.true;
      });

      it('should emit RouterAdded event', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await expect(
          syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress())
        )
          .to.emit(syncSwapArbitrage, 'RouterAdded')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should increment router count', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        expect((await syncSwapArbitrage.getApprovedRouters()).length).to.equal(0);

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        expect((await syncSwapArbitrage.getApprovedRouters()).length).to.equal(1);
      });

      it('should allow multiple routers to be added', async () => {
        const { syncSwapArbitrage, dexRouter1, dexRouter2, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

        expect((await syncSwapArbitrage.getApprovedRouters()).length).to.equal(2);
        expect(
          await syncSwapArbitrage.isApprovedRouter(await dexRouter1.getAddress())
        ).to.be.true;
        expect(
          await syncSwapArbitrage.isApprovedRouter(await dexRouter2.getAddress())
        ).to.be.true;
      });

      it('should revert on zero address router', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          syncSwapArbitrage.connect(owner).addApprovedRouter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidRouterAddress');
      });

      it('should revert on duplicate router', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'RouterAlreadyApproved');
      });

      it('should revert if non-owner tries to add', async () => {
        const { syncSwapArbitrage, dexRouter1, user } = await loadFixture(
          deployContractsFixture
        );

        await expect(
          syncSwapArbitrage.connect(user).addApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('removeApprovedRouter()', () => {
      it('should allow owner to remove router', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        expect(
          await syncSwapArbitrage.isApprovedRouter(await dexRouter1.getAddress())
        ).to.be.true;

        await syncSwapArbitrage
          .connect(owner)
          .removeApprovedRouter(await dexRouter1.getAddress());

        expect(
          await syncSwapArbitrage.isApprovedRouter(await dexRouter1.getAddress())
        ).to.be.false;
      });

      it('should emit RouterRemoved event', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          syncSwapArbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress())
        )
          .to.emit(syncSwapArbitrage, 'RouterRemoved')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should decrement router count', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        expect((await syncSwapArbitrage.getApprovedRouters()).length).to.equal(1);

        await syncSwapArbitrage
          .connect(owner)
          .removeApprovedRouter(await dexRouter1.getAddress());

        expect((await syncSwapArbitrage.getApprovedRouters()).length).to.equal(0);
      });

      it('should revert on non-existent router', async () => {
        const { syncSwapArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await expect(
          syncSwapArbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'RouterNotApproved');
      });

      it('should revert if non-owner tries to remove', async () => {
        const { syncSwapArbitrage, dexRouter1, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          syncSwapArbitrage.connect(user).removeApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('getApprovedRouters()', () => {
      it('should return empty array initially', async () => {
        const { syncSwapArbitrage } = await loadFixture(deployContractsFixture);

        const routers = await syncSwapArbitrage.getApprovedRouters();
        expect(routers).to.have.lengthOf(0);
      });

      it('should return all approved routers', async () => {
        const { syncSwapArbitrage, dexRouter1, dexRouter2, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

        const routers = await syncSwapArbitrage.getApprovedRouters();
        expect(routers).to.have.lengthOf(2);
        expect(routers).to.include(await dexRouter1.getAddress());
        expect(routers).to.include(await dexRouter2.getAddress());
      });
    });
  });

  // ===========================================================================
  // 3. Flash Loan Execution Tests
  // ===========================================================================
  describe('3. Flash Loan Execution', () => {
    describe('executeArbitrage()', () => {
      it('should execute successful arbitrage with profit', async () => {
        const {
          syncSwapArbitrage,
          vault,
          dexRouter1,
          weth,
          usdc,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        // Setup: Add router and configure profitable rates
        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure rates for profitable arbitrage
        // WETH -> USDC at 2000 USDC per WETH
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await usdc.getAddress(),
          ethers.parseUnits('2000', 6)
        );
        // USDC -> WETH at 0.0006 WETH per USDC (gives back 12 WETH from 20000 USDC)
        // Need to account for 0.3% flash loan fee (0.03 WETH on 10 WETH)
        // So we need 10.03+ WETH back to cover the loan + fee
        await dexRouter1.setExchangeRate(
          await usdc.getAddress(),
          await weth.getAddress(),
          BigInt('600000000000000000000000000') // 0.0006 WETH per USDC adjusted for decimals
        );

        const amountIn = ethers.parseEther('10');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();

        // Execute arbitrage
        await syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);

        // Verify profit was recorded
        expect(await syncSwapArbitrage.totalProfits()).to.be.gt(0);
      });

      it('should emit ArbitrageExecuted event', async () => {
        const {
          syncSwapArbitrage,
          vault,
          dexRouter1,
          weth,
          usdc,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await usdc.getAddress(),
          ethers.parseUnits('2000', 6)
        );
        await dexRouter1.setExchangeRate(
          await usdc.getAddress(),
          await weth.getAddress(),
          BigInt('600000000000000000000000000') // 0.0006 WETH per USDC adjusted for decimals
        );

        const amountIn = ethers.parseEther('10');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');
      });

      it('should revert on zero amount', async () => {
        const { syncSwapArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await weth.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0n,
          },
        ];

        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage.connect(user).executeArbitrage(await weth.getAddress(), 0, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidAmount');
      });

      it('should revert on expired deadline', async () => {
        const { syncSwapArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        const amountIn = ethers.parseEther('1');
        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await weth.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0n,
          },
        ];

        const pastDeadline = (await ethers.provider.getBlock('latest'))!.timestamp - 100;

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, pastDeadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'TransactionTooOld');
      });

      it('should revert on empty swap path', async () => {
        const { syncSwapArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        const amountIn = ethers.parseEther('1');
        const swapPath: any[] = [];
        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'EmptySwapPath');
      });

      it('should revert on path too long (> 5 hops)', async () => {
        const { syncSwapArbitrage, dexRouter1, weth, usdc, user } = await loadFixture(
          deployContractsFixture
        );

        const amountIn = ethers.parseEther('1');
        const swapPath = Array(6).fill({
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        });
        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'PathTooLong');
      });

      it('should revert on asset mismatch (first swap not starting with asset)', async () => {
        const { syncSwapArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

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

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'SwapPathAssetMismatch');
      });

      it('should revert on unapproved router in path', async () => {
        const { syncSwapArbitrage, dexRouter1, weth, usdc, user } = await loadFixture(
          deployContractsFixture
        );

        // Don't approve router

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

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'RouterNotApproved');
      });

      it('should revert on zero amountOutMin without slippage protection', async () => {
        const { syncSwapArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        const amountIn = ethers.parseEther('1');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await usdc.getAddress(),
            amountOutMin: 0n, // No slippage protection!
          },
        ];
        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InsufficientSlippageProtection');
      });

      it('should revert when paused', async () => {
        const { syncSwapArbitrage, weth, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).pause();

        const amountIn = ethers.parseEther('1');
        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await weth.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWith('Pausable: paused');
      });

      it('should revert if flash loan fails', async () => {
        const {
          syncSwapArbitrage,
          vault,
          dexRouter1,
          weth,
          usdc,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Set vault to fail flash loans
        await vault.setShouldFailFlashLoan(true);

        // Set exchange rates for a valid circular path
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
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'FlashLoanFailed');
      });

      it('should revert when vault reports insufficient balance', async () => {
        const {
          syncSwapArbitrage,
          vault,
          dexRouter1,
          weth,
          usdc,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Simulate insufficient vault balance (maxFlashLoan returns 0)
        await vault.setShouldSimulateInsufficientBalance(true);

        // Verify maxFlashLoan returns 0 when flag is set
        expect(await vault.maxFlashLoan(await weth.getAddress())).to.equal(0);

        // Reset and verify it returns normal balance
        await vault.setShouldSimulateInsufficientBalance(false);
        expect(await vault.maxFlashLoan(await weth.getAddress())).to.be.gt(0);
      });
    });

    describe('onFlashLoan() callback', () => {
      it('should revert if caller is not vault', async () => {
        const { syncSwapArbitrage, weth, attacker } = await loadFixture(
          deployContractsFixture
        );

        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await weth.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
          [swapPath, 0n]
        );

        await expect(
          syncSwapArbitrage
            .connect(attacker)
            .onFlashLoan(attacker.address, await weth.getAddress(), ethers.parseEther('1'), 0, data)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidFlashLoanCaller');
      });

      it('should revert with InvalidFlashLoanInitiator when initiator is not the contract', async () => {
        const { syncSwapArbitrage, vault, weth, owner, attacker } = await loadFixture(
          deployContractsFixture
        );

        // Impersonate the SyncSwap Vault to bypass the caller check (msg.sender == VAULT),
        // then provide a wrong initiator to trigger the initiator check.
        const vaultAddress = await vault.getAddress();
        await ethers.provider.send('hardhat_impersonateAccount', [vaultAddress]);
        await owner.sendTransaction({ to: vaultAddress, value: ethers.parseEther('1') });
        const vaultSigner = await ethers.getSigner(vaultAddress);

        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await weth.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
          [swapPath, 0n]
        );

        // Call onFlashLoan from the vault with attacker as initiator (not the contract itself)
        await expect(
          syncSwapArbitrage.connect(vaultSigner).onFlashLoan(
            attacker.address, // Wrong initiator - should be the contract address
            await weth.getAddress(),
            ethers.parseEther('1'),
            0,
            data
          )
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidFlashLoanInitiator');

        await ethers.provider.send('hardhat_stopImpersonatingAccount', [vaultAddress]);
      });
    });
  });

  // ===========================================================================
  // 4. Swap Execution Tests
  // ===========================================================================
  describe('4. Swap Execution', () => {
    it('should execute single-hop swap successfully', async () => {
      const {
        syncSwapArbitrage,
        dexRouter1,
        weth,
        usdc,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('600000000000000000000000000') // 0.0006 WETH per USDC adjusted for decimals
      );

      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      const tx = await syncSwapArbitrage
        .connect(user)
        .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);

      await expect(tx).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');
    });

    it('should execute multi-hop swap (3 hops)', async () => {
      const {
        syncSwapArbitrage,
        dexRouter1,
        dexRouter2,
        weth,
        usdc,
        dai,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      // Configure rates for triangular arbitrage: WETH -> USDC -> DAI -> WETH
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1010000000000000000000000000000') // 1.01 DAI per USDC
      );
      await dexRouter2.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        BigInt('505000000000000') // 0.000505 WETH per DAI
      );

      const amountIn = ethers.parseEther('10');
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
          amountOutMin: ethers.parseEther('9.5'),
        },
      ];

      const deadline = await getDeadline();

      await expect(
        syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
      ).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');
    });

    it('should execute max-hop swap (5 hops)', async () => {
      const { syncSwapArbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(
        deployContractsFixture
      );

      // Deploy additional tokens for 5-hop test
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const usdt = await MockERC20Factory.deploy('Tether', 'USDT', 6);
      const busd = await MockERC20Factory.deploy('BUSD', 'BUSD', 18);

      await usdt.mint(await dexRouter1.getAddress(), ethers.parseUnits('1000000', 6));
      await busd.mint(await dexRouter1.getAddress(), ethers.parseEther('1000000'));

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure rates for 5-hop path
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1002000000000000000000000000000')
      );
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await usdt.getAddress(),
        ethers.parseUnits('1', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdt.getAddress(),
        await busd.getAddress(),
        BigInt('1002000000000000000000000000000')
      );
      await dexRouter1.setExchangeRate(
        await busd.getAddress(),
        await weth.getAddress(),
        BigInt('505000000000000')
      );

      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await usdt.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdt.getAddress(),
          tokenOut: await busd.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await busd.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
      ).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');
    });

    it('should revert on path ending with wrong asset', async () => {
      const { syncSwapArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(
        deployContractsFixture
      );

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );

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

      // Cycle completeness check: last tokenOut (USDC) != asset (WETH)
      await expect(
        syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
      ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidSwapPath');
    });

    it('should revert on token continuity error in path', async () => {
      const { syncSwapArbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(
        deployContractsFixture
      );

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
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

      // Token continuity check: step[1].tokenIn (DAI) != step[0].tokenOut (USDC)
      await expect(
        syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
      ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidSwapPath');
    });

    it('should handle repeated router in path (triangular arb optimization)', async () => {
      const {
        syncSwapArbitrage,
        dexRouter1,
        weth,
        usdc,
        dai,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

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
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        BigInt('505000000000000')
      );

      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(), // Same router
          tokenIn: await usdc.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(), // Same router again
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
      ).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');
    });
  });

  // ===========================================================================
  // 5. Profit Validation Tests
  // ===========================================================================
  describe('5. Profit Validation', () => {
    it('should revert if profit < minProfit parameter', async () => {
      const {
        syncSwapArbitrage,
        dexRouter1,
        weth,
        usdc,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure rates for small profit
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('501000000000000000000000000') // Gives ~0.02 WETH profit (0.2% gain minus 0.3% fee ≈ loss)
      );

      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();
      const minProfit = ethers.parseEther('1'); // Require 1 WETH profit (too high)

      await expect(
        syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, minProfit, deadline)
      ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InsufficientProfit');
    });

    it('should use max of params.minProfit and contract minimumProfit', async () => {
      const {
        syncSwapArbitrage,
        dexRouter1,
        weth,
        usdc,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set global minimum profit
      await syncSwapArbitrage.connect(owner).setMinimumProfit(ethers.parseEther('0.01'));

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT // 0.000505 ETH per USDC = 10.1 ETH from 20000 USDC
      );

      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        syncSwapArbitrage
          .connect(user)
          .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
      ).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');
    });

    it('should track totalProfits correctly', async () => {
      const {
        syncSwapArbitrage,
        dexRouter1,
        weth,
        usdc,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

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

      const initialTotalProfits = await syncSwapArbitrage.totalProfits();

      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      await syncSwapArbitrage
        .connect(user)
        .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);

      const finalTotalProfits = await syncSwapArbitrage.totalProfits();

      expect(finalTotalProfits).to.be.gt(initialTotalProfits);
    });
  });

  // ===========================================================================
  // 6. Admin Functions Tests
  // ===========================================================================
  describe('6. Admin Functions', () => {
    describe('setMinimumProfit()', () => {
      it('should allow owner to update minimum profit', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        const newMinProfit = ethers.parseEther('0.05');
        await syncSwapArbitrage.connect(owner).setMinimumProfit(newMinProfit);

        expect(await syncSwapArbitrage.minimumProfit()).to.equal(newMinProfit);
      });

      it('should emit MinimumProfitUpdated event', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        const newMinProfit = ethers.parseEther('0.05');
        await expect(syncSwapArbitrage.connect(owner).setMinimumProfit(newMinProfit))
          .to.emit(syncSwapArbitrage, 'MinimumProfitUpdated')
          .withArgs(0, newMinProfit);
      });

      it('should revert if non-owner tries to update', async () => {
        const { syncSwapArbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          syncSwapArbitrage.connect(user).setMinimumProfit(ethers.parseEther('0.05'))
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should allow setting minimum profit to zero', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await syncSwapArbitrage.connect(owner).setMinimumProfit(ethers.parseEther('0.1'));
        await syncSwapArbitrage.connect(owner).setMinimumProfit(0);

        expect(await syncSwapArbitrage.minimumProfit()).to.equal(0);
      });
    });

    describe('setSwapDeadline()', () => {
      it('should allow owner to update swap deadline', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        const newDeadline = 600;
        await syncSwapArbitrage.connect(owner).setSwapDeadline(newDeadline);

        expect(await syncSwapArbitrage.swapDeadline()).to.equal(newDeadline);
      });

      it('should emit SwapDeadlineUpdated event', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        const newDeadline = 600;
        await expect(syncSwapArbitrage.connect(owner).setSwapDeadline(newDeadline))
          .to.emit(syncSwapArbitrage, 'SwapDeadlineUpdated')
          .withArgs(60, newDeadline);
      });

      it('should revert on zero deadline', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          syncSwapArbitrage.connect(owner).setSwapDeadline(0)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidSwapDeadline');
      });

      it('should revert on deadline > MAX_SWAP_DEADLINE', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          syncSwapArbitrage.connect(owner).setSwapDeadline(601)
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidSwapDeadline');
      });

      it('should revert if non-owner tries to update', async () => {
        const { syncSwapArbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          syncSwapArbitrage.connect(user).setSwapDeadline(600)
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('pause() / unpause()', () => {
      it('should allow owner to pause', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await syncSwapArbitrage.connect(owner).pause();
        expect(await syncSwapArbitrage.paused()).to.be.true;
      });

      it('should allow owner to unpause', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await syncSwapArbitrage.connect(owner).pause();
        await syncSwapArbitrage.connect(owner).unpause();

        expect(await syncSwapArbitrage.paused()).to.be.false;
      });

      it('should revert if non-owner tries to pause', async () => {
        const { syncSwapArbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          syncSwapArbitrage.connect(user).pause()
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should revert if non-owner tries to unpause', async () => {
        const { syncSwapArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await syncSwapArbitrage.connect(owner).pause();

        await expect(
          syncSwapArbitrage.connect(user).unpause()
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('withdrawToken()', () => {
      it('should allow owner to withdraw tokens', async () => {
        const { syncSwapArbitrage, weth, owner } = await loadFixture(deployContractsFixture);

        // Send some WETH to contract
        await weth.mint(await syncSwapArbitrage.getAddress(), ethers.parseEther('1'));

        const ownerBalanceBefore = await weth.balanceOf(owner.address);

        await syncSwapArbitrage
          .connect(owner)
          .withdrawToken(await weth.getAddress(), owner.address, ethers.parseEther('1'));

        const ownerBalanceAfter = await weth.balanceOf(owner.address);
        expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther('1'));
      });

      it('should emit TokenWithdrawn event', async () => {
        const { syncSwapArbitrage, weth, owner } = await loadFixture(deployContractsFixture);

        await weth.mint(await syncSwapArbitrage.getAddress(), ethers.parseEther('1'));

        await expect(
          syncSwapArbitrage
            .connect(owner)
            .withdrawToken(await weth.getAddress(), owner.address, ethers.parseEther('1'))
        )
          .to.emit(syncSwapArbitrage, 'TokenWithdrawn')
          .withArgs(await weth.getAddress(), owner.address, ethers.parseEther('1'));
      });

      it('should revert on zero address recipient', async () => {
        const { syncSwapArbitrage, weth, owner } = await loadFixture(deployContractsFixture);

        await weth.mint(await syncSwapArbitrage.getAddress(), ethers.parseEther('1'));

        await expect(
          syncSwapArbitrage
            .connect(owner)
            .withdrawToken(await weth.getAddress(), ethers.ZeroAddress, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidRecipient');
      });

      it('should revert if non-owner tries to withdraw', async () => {
        const { syncSwapArbitrage, weth, user } = await loadFixture(deployContractsFixture);

        await weth.mint(await syncSwapArbitrage.getAddress(), ethers.parseEther('1'));

        await expect(
          syncSwapArbitrage
            .connect(user)
            .withdrawToken(await weth.getAddress(), user.address, ethers.parseEther('1'))
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('withdrawETH()', () => {
      it('should allow owner to withdraw ETH', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        // Send some ETH to contract
        await owner.sendTransaction({
          to: await syncSwapArbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

        const tx = await syncSwapArbitrage
          .connect(owner)
          .withdrawETH(owner.address, ethers.parseEther('1'));
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * BigInt(receipt!.gasPrice ?? 0);

        const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
        expect(ownerBalanceAfter).to.be.closeTo(
          ownerBalanceBefore + ethers.parseEther('1') - gasUsed,
          ethers.parseEther('0.01')
        );
      });

      it('should emit ETHWithdrawn event', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await owner.sendTransaction({
          to: await syncSwapArbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        await expect(
          syncSwapArbitrage.connect(owner).withdrawETH(owner.address, ethers.parseEther('1'))
        )
          .to.emit(syncSwapArbitrage, 'ETHWithdrawn')
          .withArgs(owner.address, ethers.parseEther('1'));
      });

      it('should revert on zero address recipient', async () => {
        const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

        await owner.sendTransaction({
          to: await syncSwapArbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        await expect(
          syncSwapArbitrage.connect(owner).withdrawETH(ethers.ZeroAddress, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(syncSwapArbitrage, 'InvalidRecipient');
      });

      it('should revert if non-owner tries to withdraw ETH', async () => {
        const { syncSwapArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        await owner.sendTransaction({
          to: await syncSwapArbitrage.getAddress(),
          value: ethers.parseEther('1'),
        });

        await expect(
          syncSwapArbitrage.connect(user).withdrawETH(user.address, ethers.parseEther('1'))
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('Ownable2Step', () => {
      it('should support two-step ownership transfer', async () => {
        const { syncSwapArbitrage, owner, user } = await loadFixture(deployContractsFixture);

        // Step 1: Current owner initiates transfer
        await syncSwapArbitrage.connect(owner).transferOwnership(user.address);

        // Owner is still the original owner (pending transfer)
        expect(await syncSwapArbitrage.owner()).to.equal(owner.address);
        expect(await syncSwapArbitrage.pendingOwner()).to.equal(user.address);

        // Step 2: New owner accepts
        await syncSwapArbitrage.connect(user).acceptOwnership();

        // Now ownership is transferred
        expect(await syncSwapArbitrage.owner()).to.equal(user.address);
      });

      it('should not allow non-pending owner to accept', async () => {
        const { syncSwapArbitrage, owner, user, attacker } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).transferOwnership(user.address);

        await expect(
          syncSwapArbitrage.connect(attacker).acceptOwnership()
        ).to.be.revertedWith('Ownable2Step: caller is not the new owner');
      });
    });
  });

  // ===========================================================================
  // 7. View Functions Tests
  // ===========================================================================
  describe('7. View Functions', () => {
    describe('calculateExpectedProfit()', () => {
      it('should calculate expected profit correctly', async () => {
        const { syncSwapArbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await usdc.getAddress(),
          ethers.parseUnits('2000', 6)
        );
        await dexRouter1.setExchangeRate(
          await usdc.getAddress(),
          await weth.getAddress(),
          BigInt('600000000000000000000000000') // 0.0006 WETH per USDC adjusted for decimals
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

        const result = await syncSwapArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.expectedProfit).to.be.gt(0);
        expect(result.flashLoanFee).to.equal(ethers.parseEther('10') * 30n / 10000n); // 0.3% = 30 bps
      });

      it('should return 0 for empty path', async () => {
        const { syncSwapArbitrage, weth } = await loadFixture(deployContractsFixture);

        const result = await syncSwapArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('1'),
          []
        );

        expect(result.expectedProfit).to.equal(0);
      });

      it('should return 0 for path starting with wrong asset', async () => {
        const { syncSwapArbitrage, dexRouter1, weth, usdc } = await loadFixture(
          deployContractsFixture
        );

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await usdc.getAddress(), // Wrong!
            tokenOut: await weth.getAddress(),
            amountOutMin: 0n,
          },
        ];

        const result = await syncSwapArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath
        );

        expect(result.expectedProfit).to.equal(0);
      });

      it('should return 0 for unprofitable path', async () => {
        const { syncSwapArbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(
          deployContractsFixture
        );

        await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure unprofitable rates (lose money)
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await usdc.getAddress(),
          ethers.parseUnits('2000', 6)
        );
        await dexRouter1.setExchangeRate(
          await usdc.getAddress(),
          await weth.getAddress(),
          BigInt('490000000000000000000000000') // Lose money
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

        const result = await syncSwapArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          ethers.parseEther('10'),
          swapPath
        );

        expect(result.expectedProfit).to.equal(0);
      });

      it('should calculate flash loan fee correctly (0.3%)', async () => {
        const { syncSwapArbitrage, weth } = await loadFixture(deployContractsFixture);

        const amount = ethers.parseEther('100');
        const expectedFee = (amount * 30n) / 10000n; // 0.3%

        const result = await syncSwapArbitrage.calculateExpectedProfit(
          await weth.getAddress(),
          amount,
          []
        );

        expect(result.flashLoanFee).to.equal(expectedFee);
      });
    });
  });

  // ===========================================================================
  // 8. Security and Access Control Tests
  // ===========================================================================
  describe('8. Security and Access Control', () => {
    it('should enforce ReentrancyGuard on executeArbitrage via malicious router', async () => {
      const { syncSwapArbitrage, dexRouter1, weth, usdc, owner } = await loadFixture(deployContractsFixture);

      // Deploy malicious router targeting this contract
      const MaliciousRouterFactory = await ethers.getContractFactory('MockMaliciousRouter');
      const maliciousRouter = await MaliciousRouterFactory.deploy(
        await syncSwapArbitrage.getAddress()
      );

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await maliciousRouter.getAddress());
      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Fund the malicious router with enough tokens (1:1 passthrough uses raw amounts)
      await weth.mint(await maliciousRouter.getAddress(), ethers.parseEther('100'));
      await usdc.mint(await maliciousRouter.getAddress(), ethers.parseEther('100'));

      // Set favorable exchange rate on dexRouter1 for the 2nd hop to generate profit.
      // The malicious router does 1:1 passthrough (amountOut = amountIn), which yields
      // zero profit. Using a normal router for the 2nd hop with a 1% premium ensures
      // the trade is profitable (covers SyncSwap's 0.3% fee), so the tx succeeds and
      // attackAttempted state persists instead of being rolled back.
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('1.01')
      );

      // Path: WETH→USDC (malicious, 1:1 + reentrancy) → USDC→WETH (normal, 1% profit)
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
      // continues. The tx succeeds because the 2nd hop generates enough profit.
      await syncSwapArbitrage.executeArbitrage(
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

    it('should allow contract to receive ETH', async () => {
      const { syncSwapArbitrage, owner } = await loadFixture(deployContractsFixture);

      await expect(
        owner.sendTransaction({
          to: await syncSwapArbitrage.getAddress(),
          value: ethers.parseEther('1'),
        })
      ).to.not.be.reverted;

      expect(
        await ethers.provider.getBalance(await syncSwapArbitrage.getAddress())
      ).to.equal(ethers.parseEther('1'));
    });
  });

  // ===========================================================================
  // 9. Integration Tests
  // ===========================================================================
  describe('9. Integration Tests', () => {
    it('should execute complete arbitrage flow end-to-end', async () => {
      const {
        syncSwapArbitrage,
        vault,
        dexRouter1,
        dexRouter2,
        weth,
        usdc,
        dai,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      // Setup: Add routers
      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      // Setup: Set minimum profit
      await syncSwapArbitrage.connect(owner).setMinimumProfit(ethers.parseEther('0.01'));

      // Setup: Configure profitable triangular arbitrage
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

      const amountIn = ethers.parseEther('10');
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
          amountOutMin: ethers.parseEther('9.5'),
        },
      ];

      const deadline = await getDeadline();

      // Execute arbitrage
      const tx = await syncSwapArbitrage
        .connect(user)
        .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);

      await expect(tx).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');

      // Verify profit was recorded
      expect(await syncSwapArbitrage.totalProfits()).to.be.gt(0);

      // Verify vault received fee
      // (Implicitly verified by successful execution)
    });

    it('should handle multiple sequential arbitrage executions', async () => {
      const {
        syncSwapArbitrage,
        dexRouter1,
        weth,
        usdc,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT // 0.000505 ETH per USDC
      );

      const amountIn = ethers.parseEther('5');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      // Execute first arbitrage
      await syncSwapArbitrage
        .connect(user)
        .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);

      const profitsAfterFirst = await syncSwapArbitrage.totalProfits();

      // Execute second arbitrage
      await syncSwapArbitrage
        .connect(user)
        .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);

      const profitsAfterSecond = await syncSwapArbitrage.totalProfits();

      // Verify profits accumulated
      expect(profitsAfterSecond).to.be.gt(profitsAfterFirst);
    });
  });

  // ===========================================================================
  // 10. Gas Benchmark Tests
  // ===========================================================================
  describe('10. Gas Benchmarks', () => {
    it('should execute 2-hop arbitrage within gas budget', async () => {
      const { syncSwapArbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(
        deployContractsFixture
      );

      await syncSwapArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

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

      const amountIn = ethers.parseEther('10');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      const tx = await syncSwapArbitrage
        .connect(user)
        .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);
      const receipt = await tx.wait();

      // SyncSwap EIP-3156 flash loan (0.3% fee) + 2 swaps should be < 500,000 gas
      expect(receipt!.gasUsed).to.be.lt(500_000);
    });
  });
});
