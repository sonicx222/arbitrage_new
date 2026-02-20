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
 * BalancerV2FlashArbitrage Contract Tests
 *
 * Tests comprehensive coverage for Task 2.2: Balancer V2 Flash Loan Provider
 *
 * Contract uses Balancer V2 flash loans (0% fees) for arbitrage execution.
 * Key features:
 * - Single Vault contract per chain (no pool discovery)
 * - Zero flash loan fees
 * - Multi-hop swap execution
 * - Router approval system
 * - Profit verification
 *
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */
describe('BalancerV2FlashArbitrage', () => {
  // Test fixtures for consistent state
  async function deployContractsFixture() {
    const BALANCER_AMOUNTS = {
      wethPerRouter: ethers.parseEther('10000'),
      usdcPerRouter: ethers.parseUnits('10000000', 6),
      daiPerRouter: ethers.parseEther('10000000'),
    };
    const base = await deployBaseFixture(BALANCER_AMOUNTS);

    // Deploy Balancer Vault and fund it for flash loans
    const MockBalancerVaultFactory = await ethers.getContractFactory('MockBalancerVault');
    const vault = await MockBalancerVaultFactory.deploy();
    await fundProvider(base, await vault.getAddress(), BALANCER_AMOUNTS);

    // Deploy BalancerV2FlashArbitrage contract
    const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory('BalancerV2FlashArbitrage');
    const arbitrage = await BalancerV2FlashArbitrageFactory.deploy(
      await vault.getAddress(),
      base.owner.address
    );

    return { arbitrage, vault, ...base };
  }

  // ===========================================================================
  // 1. Deployment and Initialization Tests
  // ===========================================================================
  describe('1. Deployment and Initialization', () => {
    it('should deploy with correct owner', async () => {
      const { arbitrage, owner } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.owner()).to.equal(owner.address);
    });

    it('should deploy with correct vault address', async () => {
      const { arbitrage, vault } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.VAULT()).to.equal(await vault.getAddress());
    });

    it('should set initial minimumProfit to default (1e14)', async () => {
      const { arbitrage } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.minimumProfit()).to.equal(BigInt(1e14));
    });

    it('should set initial totalProfits to 0', async () => {
      const { arbitrage } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.totalProfits()).to.equal(0);
    });

    it('should set default swap deadline', async () => {
      const { arbitrage } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.swapDeadline()).to.equal(60);
    });

    it('should initialize with correct constants', async () => {
      const { arbitrage } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.DEFAULT_SWAP_DEADLINE()).to.equal(60);
      expect(await arbitrage.MAX_SWAP_DEADLINE()).to.equal(600);
      expect(await arbitrage.MIN_SLIPPAGE_BPS()).to.equal(10);
      expect(await arbitrage.MAX_SWAP_HOPS()).to.equal(5);
    });

    it('should revert on zero vault address', async () => {
      const { owner } = await loadFixture(deployContractsFixture);
      const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory('BalancerV2FlashArbitrage');

      await expect(
        BalancerV2FlashArbitrageFactory.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: BalancerV2FlashArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should revert on EOA vault address (no code)', async () => {
      const { owner, user } = await loadFixture(deployContractsFixture);
      const BalancerV2FlashArbitrageFactory = await ethers.getContractFactory('BalancerV2FlashArbitrage');

      // User address is an EOA, not a contract
      await expect(
        BalancerV2FlashArbitrageFactory.deploy(user.address, owner.address)
      ).to.be.revertedWithCustomError(
        { interface: BalancerV2FlashArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should not be paused on deployment', async () => {
      const { arbitrage } = await loadFixture(deployContractsFixture);
      expect(await arbitrage.paused()).to.be.false;
    });

    it('should start with no approved routers', async () => {
      const { arbitrage } = await loadFixture(deployContractsFixture);
      const routers = await arbitrage.getApprovedRouters();
      expect(routers.length).to.equal(0);
    });
  });

  // ===========================================================================
  // 2. Router Management Tests
  // ===========================================================================
  describe('2. Router Management', () => {
    describe('addApprovedRouter()', () => {
      it('should allow owner to add router', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        expect(await arbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
      });

      it('should emit RouterAdded event', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await expect(arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress()))
          .to.emit(arbitrage, 'RouterAdded')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should add router to list', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        const routers = await arbitrage.getApprovedRouters();
        expect(routers.length).to.equal(1);
        expect(routers[0]).to.equal(await dexRouter1.getAddress());
      });

      it('should revert on zero address', async () => {
        const { arbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(owner).addApprovedRouter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(arbitrage, 'InvalidRouterAddress');
      });

      it('should revert on duplicate router', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWithCustomError(arbitrage, 'RouterAlreadyApproved');
      });

      it('should revert if non-owner tries to add', async () => {
        const { arbitrage, dexRouter1, user } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(user).addApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should allow adding multiple routers', async () => {
        const { arbitrage, dexRouter1, dexRouter2, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        await arbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

        const routers = await arbitrage.getApprovedRouters();
        expect(routers.length).to.equal(2);
        expect(routers).to.include(await dexRouter1.getAddress());
        expect(routers).to.include(await dexRouter2.getAddress());
      });
    });

    describe('removeApprovedRouter()', () => {
      it('should allow owner to remove router', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        expect(await arbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;

        await arbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress());
        expect(await arbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.false;
      });

      it('should emit RouterRemoved event', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(arbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress()))
          .to.emit(arbitrage, 'RouterRemoved')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should remove router from list', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        await arbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress());

        const routers = await arbitrage.getApprovedRouters();
        expect(routers.length).to.equal(0);
      });

      it('should revert on non-approved router', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await expect(
          arbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWithCustomError(arbitrage, 'RouterNotApproved');
      });

      it('should revert if non-owner tries to remove', async () => {
        const { arbitrage, dexRouter1, owner, user } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          arbitrage.connect(user).removeApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('isApprovedRouter()', () => {
      it('should return true for approved router', async () => {
        const { arbitrage, dexRouter1, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        expect(await arbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.true;
      });

      it('should return false for non-approved router', async () => {
        const { arbitrage, dexRouter1 } = await loadFixture(deployContractsFixture);

        expect(await arbitrage.isApprovedRouter(await dexRouter1.getAddress())).to.be.false;
      });
    });

    describe('getApprovedRouters()', () => {
      it('should return empty array initially', async () => {
        const { arbitrage } = await loadFixture(deployContractsFixture);

        const routers = await arbitrage.getApprovedRouters();
        expect(routers.length).to.equal(0);
      });

      it('should return all approved routers', async () => {
        const { arbitrage, dexRouter1, dexRouter2, owner } = await loadFixture(deployContractsFixture);

        await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        await arbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

        const routers = await arbitrage.getApprovedRouters();
        expect(routers.length).to.equal(2);
        expect(routers).to.include(await dexRouter1.getAddress());
        expect(routers).to.include(await dexRouter2.getAddress());
      });
    });
  });

  // ===========================================================================
  // 3. Flash Loan Execution Tests
  // ===========================================================================
  describe('3. Flash Loan Execution', () => {
    it('should execute simple arbitrage successfully', async () => {
      const { arbitrage, vault, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      // Setup: Approve router and set profitable exchange rates (using same pattern as CommitRevealArbitrage tests)
      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // WETH -> USDC: 1 WETH = 2000 USDC
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );

      // USDC -> WETH: rate that gives profit
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        RATE_USDC_TO_WETH_1PCT_PROFIT
      );

      const amount = ethers.parseEther('1');
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

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        amount,
        swapPath,
        0,
        deadline
      );

      // Verify profit was made
      const contractBalance = await weth.balanceOf(await arbitrage.getAddress());
      expect(contractBalance).to.be.gt(0);
    });

    it('should emit ArbitrageExecuted event', async () => {
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

      const amount = ethers.parseEther('10');
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
          amount,
          swapPath,
          0,
          deadline
        )
      ).to.emit(arbitrage, 'ArbitrageExecuted');
    });

    it('should update totalProfits after execution', async () => {
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

      const amount = ethers.parseEther('10');
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

      const totalProfitsBefore = await arbitrage.totalProfits();

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        amount,
        swapPath,
        0,
        deadline
      );

      const totalProfitsAfter = await arbitrage.totalProfits();
      expect(totalProfitsAfter).to.be.gt(totalProfitsBefore);
    });

    it('should update tokenProfits per-asset after execution', async () => {
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

      const amount = ethers.parseEther('10');
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

      // tokenProfits should be 0 for WETH before execution
      const wethProfitsBefore = await arbitrage.tokenProfits(await weth.getAddress());
      expect(wethProfitsBefore).to.equal(0);

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        amount,
        swapPath,
        0,
        deadline
      );

      // tokenProfits should track per-token (WETH), not USDC
      const wethProfitsAfter = await arbitrage.tokenProfits(await weth.getAddress());
      const usdcProfitsAfter = await arbitrage.tokenProfits(await usdc.getAddress());
      expect(wethProfitsAfter).to.be.gt(0);
      expect(usdcProfitsAfter).to.equal(0); // No USDC arbitrage was executed
    });

    it('should revert on zero-profit trade (Fix 4a)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Set exchange rates that produce exactly zero profit after swaps
      // (output equals input — the flash loan fee is 0 for Balancer)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        BigInt('500000000000000000000000000') // 1 USDC = 0.0005 WETH → 10 WETH → 20000 USDC → 10 WETH (break-even)
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

      // Even with minProfit=0, a zero-profit trade should revert
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

    it('should revert on zero amount', async () => {
      const { arbitrage, dexRouter1, weth, user } = await loadFixture(deployContractsFixture);

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 0,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          0,
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'InvalidAmount');
    });

    it('should revert on expired deadline', async () => {
      const { arbitrage, dexRouter1, weth, user } = await loadFixture(deployContractsFixture);

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 0,
        },
      ];

      const deadline = await getDeadline(-100); // Past deadline

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'TransactionTooOld');
    });

    it('should revert on empty swap path', async () => {
      const { arbitrage, weth, user } = await loadFixture(deployContractsFixture);

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          [],
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'EmptySwapPath');
    });

    it('should revert on path too long (> 5 hops)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Create 6-hop path
      const swapPath = Array(6).fill({
        router: await dexRouter1.getAddress(),
        tokenIn: await weth.getAddress(),
        tokenOut: await usdc.getAddress(),
        amountOutMin: 1,
      });

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'PathTooLong');
    });

    it('should revert on asset mismatch (first hop)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(), // Wrong! Should be WETH
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'SwapPathAssetMismatch');
    });

    it('should revert on unapproved router', async () => {
      const { arbitrage, dexRouter1, weth, usdc, user } = await loadFixture(deployContractsFixture);

      // Don't approve the router

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'RouterNotApproved');
    });

    it('should revert on zero amountOutMin without slippage protection', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 0, // Zero slippage protection!
        },
      ];

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWithCustomError(arbitrage, 'InsufficientSlippageProtection');
    });

    it('should revert when paused', async () => {
      const { arbitrage, dexRouter1, weth, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).pause();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        arbitrage.connect(user).executeArbitrage(
          await weth.getAddress(),
          ethers.parseEther('1'),
          swapPath,
          0,
          deadline
        )
      ).to.be.revertedWith('Pausable: paused');
    });
  });

  // ===========================================================================
  // 4. Swap Execution Tests
  // ===========================================================================
  describe('4. Swap Execution (_executeSwaps)', () => {
    it('should execute single-hop swap', async () => {
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

      await arbitrage.connect(user).executeArbitrage(
        await weth.getAddress(),
        ethers.parseEther('10'),
        swapPath,
        0,
        deadline
      );

      expect(await weth.balanceOf(await arbitrage.getAddress())).to.be.gt(0);
    });

    it('should execute multi-hop swap (3 hops)', async () => {
      const { arbitrage, dexRouter1, dexRouter2, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await arbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      // WETH -> USDC
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );

      // USDC -> DAI
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1010000000000000000000000000000')
      );

      // DAI -> WETH
      await dexRouter2.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        BigInt('510000000000000')
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
          tokenOut: await dai.getAddress(),
          amountOutMin: ethers.parseEther('19000'),
        },
        {
          router: await dexRouter2.getAddress(),
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

    it('should execute max-hop swap (5 hops)', async () => {
      const { arbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

      // Deploy additional tokens
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const usdt = await MockERC20Factory.deploy('Tether', 'USDT', 6);
      const busd = await MockERC20Factory.deploy('BUSD', 'BUSD', 18);

      await usdt.mint(await dexRouter1.getAddress(), ethers.parseUnits('10000000', 6));
      await busd.mint(await dexRouter1.getAddress(), ethers.parseEther('10000000'));

      await arbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure 5-hop path: WETH -> USDC -> DAI -> USDT -> BUSD -> WETH
      await dexRouter1.setExchangeRate(await weth.getAddress(), await usdc.getAddress(), ethers.parseUnits('2000', 6));
      await dexRouter1.setExchangeRate(await usdc.getAddress(), await dai.getAddress(), BigInt('1002000000000000000000000000000'));
      await dexRouter1.setExchangeRate(await dai.getAddress(), await usdt.getAddress(), ethers.parseUnits('1', 6));
      await dexRouter1.setExchangeRate(await usdt.getAddress(), await busd.getAddress(), BigInt('1002000000000000000000000000000'));
      await dexRouter1.setExchangeRate(await busd.getAddress(), await weth.getAddress(), BigInt('505000000000000'));

      const swapPath = [
        { router: await dexRouter1.getAddress(), tokenIn: await weth.getAddress(), tokenOut: await usdc.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await usdc.getAddress(), tokenOut: await dai.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await dai.getAddress(), tokenOut: await usdt.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await usdt.getAddress(), tokenOut: await busd.getAddress(), amountOutMin: 1 },
        { router: await dexRouter1.getAddress(), tokenIn: await busd.getAddress(), tokenOut: await weth.getAddress(), amountOutMin: 1 },
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

    it('should revert on token continuity error', async () => {
      const { arbitrage, dexRouter1, weth, usdc, dai, owner, user } = await loadFixture(deployContractsFixture);

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
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(), // Wrong! Should be USDC
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
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
      ).to.be.revertedWithCustomError(arbitrage, 'InvalidSwapPath');
    });

    it('should revert if path does not end with start asset', async () => {
      const { arbitrage, dexRouter1, weth, usdc, owner, user } = await loadFixture(deployContractsFixture);

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
          amountOutMin: 1,
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
      ).to.be.revertedWithCustomError(arbitrage, 'InvalidSwapPath');
    });

    it('should revert on insufficient output amount', async () => {
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
          amountOutMin: ethers.parseUnits('25000', 6), // Too high!
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1,
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
      ).to.be.revertedWith('Insufficient output amount');
    });
  });

  // ===========================================================================
  // 5. Security Tests
  // ===========================================================================
  describe('5. Security', () => {
    it('should revert receiveFlashLoan when called by non-vault address (GAP-003)', async () => {
      const { arbitrage, weth, attacker } = await loadFixture(deployContractsFixture);

      const tokens = [await weth.getAddress()];
      const amounts = [ethers.parseEther('10')];
      const feeAmounts = [0n];
      const userData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
        [[], 0n]
      );

      await expect(
        arbitrage.connect(attacker).receiveFlashLoan(tokens, amounts, feeAmounts, userData)
      ).to.be.revertedWithCustomError(arbitrage, 'InvalidFlashLoanCaller');
    });
  });

});
