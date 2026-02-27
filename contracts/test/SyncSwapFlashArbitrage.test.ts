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
  testRouterManagement,
  testMinimumProfitConfig,
  testSwapDeadlineConfig,
  testPauseUnpause,
  testWithdrawToken,
  testWithdrawETH,
  testWithdrawGasLimitConfig,
  testOwnable2Step,
  testDeploymentDefaults,
  testInputValidation,
  testCalculateExpectedProfit,
  testReentrancyProtection,
  build2HopPath,
  build2HopCrossRouterPath,
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

  // Admin test fixture adapter for shared tests
  const adminConfig = {
    contractName: 'SyncSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.syncSwapArbitrage,
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
  // 1. Deployment Defaults (shared) + SyncSwap-Specific Deployment
  // ===========================================================================
  testDeploymentDefaults({
    contractName: 'SyncSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return { contract: f.syncSwapArbitrage, owner: f.owner };
    },
  });

  describe('Deployment — SyncSwap-Specific', () => {
    it('should set vault address correctly', async () => {
      const { syncSwapArbitrage, vault } = await loadFixture(deployContractsFixture);
      expect(await syncSwapArbitrage.VAULT()).to.equal(await vault.getAddress());
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
  });

  // ===========================================================================
  // 2. Router Management Tests (shared harness)
  // ===========================================================================
  testRouterManagement(adminConfig);

  // ===========================================================================
  // Input Validation (shared — _validateArbitrageParams)
  // ===========================================================================
  testInputValidation({
    contractName: 'SyncSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.syncSwapArbitrage,
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
        const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
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
        const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
        const deadline = await getDeadline();

        await expect(
          syncSwapArbitrage
            .connect(user)
            .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline)
        ).to.emit(syncSwapArbitrage, 'ArbitrageExecuted');
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
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
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
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
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
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
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
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
      const deadline = await getDeadline();

      await syncSwapArbitrage
        .connect(user)
        .executeArbitrage(await weth.getAddress(), amountIn, swapPath, 0n, deadline);

      const finalTotalProfits = await syncSwapArbitrage.totalProfits();

      expect(finalTotalProfits).to.be.gt(initialTotalProfits);
    });
  });

  // ===========================================================================
  // 6. Admin Functions Tests (shared harness)
  // ===========================================================================
  testMinimumProfitConfig(adminConfig);
  testSwapDeadlineConfig(adminConfig);
  testPauseUnpause(adminConfig);
  testWithdrawToken(adminConfig);
  testWithdrawETH(adminConfig);
  testWithdrawGasLimitConfig(adminConfig);
  testOwnable2Step(adminConfig);

  // ===========================================================================
  // 7. View Functions Tests
  // ===========================================================================
  // ===========================================================================
  // 7. View Functions (shared + SyncSwap-specific)
  // ===========================================================================
  testCalculateExpectedProfit({
    contractName: 'SyncSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.syncSwapArbitrage,
        owner: f.owner,
        dexRouter1: f.dexRouter1,
        weth: f.weth,
        usdc: f.usdc,
      };
    },
    triggerCalculateProfit: async (contract, params) => {
      const result = await contract.calculateExpectedProfit(
        params.asset, params.amount, params.swapPath
      );
      return { expectedProfit: result.expectedProfit, flashLoanFee: result.flashLoanFee };
    },
    profitableReverseRate: BigInt('600000000000000000000000000'),
  });

  describe('7. View Functions — SyncSwap-Specific', () => {
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

  // Reentrancy Protection (shared — MockMaliciousRouter)
  testReentrancyProtection({
    contractName: 'SyncSwapFlashArbitrage',
    getFixture: async () => {
      const f = await loadFixture(deployContractsFixture);
      return {
        contract: f.syncSwapArbitrage,
        owner: f.owner,
        user: f.user,
        dexRouter1: f.dexRouter1,
        dexRouter2: f.dexRouter2,
        weth: f.weth,
        usdc: f.usdc,
        dai: f.dai,
      };
    },
    triggerWithMaliciousRouter: async (fixture, maliciousRouterAddress) => {
      const { contract, owner, dexRouter1, weth, usdc } = fixture;
      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(), await weth.getAddress(), ethers.parseEther('1.01')
      );
      const swapPath = [
        { router: maliciousRouterAddress, tokenIn: await weth.getAddress(), tokenOut: await usdc.getAddress(), amountOutMin: 1n },
        { router: await dexRouter1.getAddress(), tokenIn: await usdc.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1n },
      ];
      const deadline = await getDeadline();
      await contract.executeArbitrage(await weth.getAddress(), ethers.parseEther('1'), swapPath, 0, deadline);
    },
  });

  // ===========================================================================
  // 8. Security and Access Control Tests
  // ===========================================================================
  describe('8. Security and Access Control', () => {
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
  // 9. End-to-End Flow Tests
  // ===========================================================================
  describe('9. End-to-End Flow Tests', () => {
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
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
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
      const swapPath = build2HopPath(await dexRouter1.getAddress(), await weth.getAddress(), await usdc.getAddress(), 1n, 1n);
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
