import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import {
  DaiFlashMintArbitrage,
  MockDexRouter,
  MockERC20,
  MockDssFlash,
} from '../typechain-types';
import {
  deployBaseFixture,
  fundProvider,
  getDeadline,
} from './helpers';

/**
 * DaiFlashMintArbitrage Contract Tests
 *
 * Test suite for DAI Flash Mint arbitrage using MakerDAO's DssFlash module (EIP-3156).
 *
 * Contract implements EIP-3156 compliant flash mint arbitrage:
 * 1. Flash mint DAI from DssFlash (1 bps / 0.01% fee)
 * 2. Multi-hop swap execution across approved DEX routers
 * 3. Profit verification and tracking
 * 4. Router whitelist management
 * 5. Emergency controls (pause/unpause)
 *
 * @see contracts/src/DaiFlashMintArbitrage.sol
 */
describe('DaiFlashMintArbitrage', () => {
  // ==========================================================================
  // Test Fixture
  // ==========================================================================
  async function deployContractsFixture() {
    const base = await deployBaseFixture();

    // Deploy MockDssFlash with 1 bps fee (0.01%)
    const MockDssFlashFactory = await ethers.getContractFactory('MockDssFlash');
    const dssFlash = await MockDssFlashFactory.deploy(1); // 1 bps fee

    // Fund DssFlash with DAI so it can issue flash loans
    await fundProvider(base, await dssFlash.getAddress());

    // Deploy DaiFlashMintArbitrage contract
    const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
      'DaiFlashMintArbitrage'
    );
    const daiArbitrage = await DaiFlashMintArbitrageFactory.deploy(
      await dssFlash.getAddress(),
      await base.dai.getAddress(),
      base.owner.address
    );

    return { daiArbitrage, dssFlash, ...base };
  }

  // ==========================================================================
  // 1. Deployment and Initialization Tests
  // ==========================================================================
  describe('1. Deployment and Initialization', () => {
    it('should deploy with correct owner', async () => {
      const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.owner()).to.equal(owner.address);
    });

    it('should set DSS_FLASH address correctly', async () => {
      const { daiArbitrage, dssFlash } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.DSS_FLASH()).to.equal(await dssFlash.getAddress());
    });

    it('should set DAI address correctly', async () => {
      const { daiArbitrage, dai } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.DAI()).to.equal(await dai.getAddress());
    });

    it('should initialize with default minimum profit (1e14)', async () => {
      const { daiArbitrage } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.minimumProfit()).to.equal(BigInt(1e14));
    });

    it('should initialize with zero total profits', async () => {
      const { daiArbitrage } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.totalProfits()).to.equal(0);
    });

    it('should initialize with default swap deadline (60 seconds)', async () => {
      const { daiArbitrage } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.swapDeadline()).to.equal(60);
    });

    it('should verify constants are set correctly', async () => {
      const { daiArbitrage } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.DEFAULT_SWAP_DEADLINE()).to.equal(60);
      expect(await daiArbitrage.MAX_SWAP_DEADLINE()).to.equal(600);
      expect(await daiArbitrage.MIN_SLIPPAGE_BPS()).to.equal(10);
      expect(await daiArbitrage.MAX_SWAP_HOPS()).to.equal(5);
    });

    it('should revert on zero address dssFlash', async () => {
      const [owner] = await ethers.getSigners();
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const dai = await MockERC20Factory.deploy('DAI', 'DAI', 18);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          ethers.ZeroAddress,
          await dai.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should revert on non-contract dssFlash address (EOA)', async () => {
      const [owner, user] = await ethers.getSigners();
      const MockERC20Factory = await ethers.getContractFactory('MockERC20');
      const dai = await MockERC20Factory.deploy('DAI', 'DAI', 18);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          user.address,
          await dai.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidProtocolAddress'
      );
    });

    it('should revert on zero address DAI', async () => {
      const [owner] = await ethers.getSigners();
      const MockDssFlashFactory = await ethers.getContractFactory('MockDssFlash');
      const dssFlash = await MockDssFlashFactory.deploy(1);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          await dssFlash.getAddress(),
          ethers.ZeroAddress,
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidDaiAddress'
      );
    });

    it('should revert on non-contract DAI address (EOA)', async () => {
      const [owner, user] = await ethers.getSigners();
      const MockDssFlashFactory = await ethers.getContractFactory('MockDssFlash');
      const dssFlash = await MockDssFlashFactory.deploy(1);

      const DaiFlashMintArbitrageFactory = await ethers.getContractFactory(
        'DaiFlashMintArbitrage'
      );
      await expect(
        DaiFlashMintArbitrageFactory.deploy(
          await dssFlash.getAddress(),
          user.address,
          owner.address
        )
      ).to.be.revertedWithCustomError(
        { interface: DaiFlashMintArbitrageFactory.interface },
        'InvalidDaiAddress'
      );
    });

    it('should initialize with empty approved router list', async () => {
      const { daiArbitrage } = await loadFixture(deployContractsFixture);
      expect((await daiArbitrage.getApprovedRouters()).length).to.equal(0);
    });

    it('should start in unpaused state', async () => {
      const { daiArbitrage } = await loadFixture(deployContractsFixture);
      expect(await daiArbitrage.paused()).to.be.false;
    });
  });

  // ==========================================================================
  // 2. Router Management Tests
  // ==========================================================================
  describe('2. Router Management', () => {
    describe('addApprovedRouter()', () => {
      it('should allow owner to add router', async () => {
        const { daiArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        expect(
          await daiArbitrage.isApprovedRouter(await dexRouter1.getAddress())
        ).to.be.true;
      });

      it('should emit RouterAdded event', async () => {
        const { daiArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await expect(
          daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress())
        )
          .to.emit(daiArbitrage, 'RouterAdded')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should revert on zero address router', async () => {
        const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(owner).addApprovedRouter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidRouterAddress');
      });

      it('should revert on duplicate router', async () => {
        const { daiArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWithCustomError(daiArbitrage, 'RouterAlreadyApproved');
      });

      it('should revert if non-owner tries to add', async () => {
        const { daiArbitrage, dexRouter1, user } = await loadFixture(
          deployContractsFixture
        );

        await expect(
          daiArbitrage.connect(user).addApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('removeApprovedRouter()', () => {
      it('should allow owner to remove router', async () => {
        const { daiArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
        await daiArbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress());

        expect(
          await daiArbitrage.isApprovedRouter(await dexRouter1.getAddress())
        ).to.be.false;
      });

      it('should emit RouterRemoved event', async () => {
        const { daiArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          daiArbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress())
        )
          .to.emit(daiArbitrage, 'RouterRemoved')
          .withArgs(await dexRouter1.getAddress());
      });

      it('should revert on non-existent router', async () => {
        const { daiArbitrage, dexRouter1, owner } = await loadFixture(
          deployContractsFixture
        );

        await expect(
          daiArbitrage.connect(owner).removeApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWithCustomError(daiArbitrage, 'RouterNotApproved');
      });

      it('should revert if non-owner tries to remove', async () => {
        const { daiArbitrage, dexRouter1, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await expect(
          daiArbitrage.connect(user).removeApprovedRouter(await dexRouter1.getAddress())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });
  });

  // ==========================================================================
  // 3. Flash Loan Execution Tests
  // ==========================================================================
  describe('3. Flash Loan Execution', () => {
    describe('executeArbitrage()', () => {
      it('should execute successful arbitrage with profit', async () => {
        const {
          daiArbitrage,
          dssFlash,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        // Setup: Add router and configure profitable rates
        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure rates for profitable arbitrage
        // DAI -> WETH: 1 DAI = 0.0005 WETH (2000 DAI per WETH)
        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005') // 0.0005 WETH per DAI
        );
        // WETH -> DAI: 1 WETH = 2100 DAI (profitable return: ~5% profit)
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100') // 2100 DAI per WETH
        );

        const amountIn = ethers.parseEther('10000'); // 10000 DAI
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();

        // Execute arbitrage (note: no asset param, always DAI)
        await daiArbitrage
          .connect(user)
          .executeArbitrage(amountIn, swapPath, 0n, deadline);

        // Verify profit was recorded
        expect(await daiArbitrage.totalProfits()).to.be.gt(0);
      });

      it('should emit ArbitrageExecuted event', async () => {
        const {
          daiArbitrage,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure profitable rates
        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100')
        );

        const amountIn = ethers.parseEther('10000');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.emit(daiArbitrage, 'ArbitrageExecuted');
      });

      it('should track per-token profit correctly', async () => {
        const {
          daiArbitrage,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100')
        );

        const amountIn = ethers.parseEther('10000');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();
        await daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline);

        // Verify DAI-specific profit tracking
        const daiProfit = await daiArbitrage.tokenProfits(await dai.getAddress());
        expect(daiProfit).to.be.gt(0);
      });

      it('should revert on insufficient profit', async () => {
        const {
          daiArbitrage,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Configure rates with very small profit (less than minimumProfit of 1e14)
        // DAI -> WETH: 0.0005 WETH per DAI
        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        // WETH -> DAI: 2000.02 DAI per WETH (barely covers fee, very small profit)
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2000.02')
        );

        const amountIn = ethers.parseEther('100'); // 100 DAI
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();

        // Profit is ~0.01 DAI = 1e16 wei, but minProfit set very high
        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, ethers.parseEther('1000'), deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InsufficientProfit');
      });

      it('should revert on zero amount', async () => {
        const { daiArbitrage, dai, dexRouter1, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(0, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidAmount');
      });

      it('should revert on expired deadline', async () => {
        const { daiArbitrage, dai, dexRouter1, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        const amountIn = ethers.parseEther('1');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const pastDeadline = (await ethers.provider.getBlock('latest'))!.timestamp - 100;

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, pastDeadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'TransactionTooOld');
      });

      it('should revert on empty swap path', async () => {
        const { daiArbitrage, user } = await loadFixture(deployContractsFixture);

        const amountIn = ethers.parseEther('1');
        const swapPath: any[] = [];
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'EmptySwapPath');
      });

      it('should revert on path too long (> 5 hops)', async () => {
        const { daiArbitrage, dexRouter1, dai, weth, user } = await loadFixture(
          deployContractsFixture
        );

        const amountIn = ethers.parseEther('1');
        const swapPath = Array(6).fill({
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        });
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'PathTooLong');
      });

      it('should revert on asset mismatch (first swap not starting with DAI)', async () => {
        const { daiArbitrage, dexRouter1, dai, weth, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        const amountIn = ethers.parseEther('1');
        // First swap starts with WETH, not DAI
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(), // Wrong! Should be DAI
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'SwapPathAssetMismatch');
      });

      it('should revert on unapproved router in path', async () => {
        const { daiArbitrage, dexRouter1, dai, weth, user } = await loadFixture(
          deployContractsFixture
        );

        // Don't approve router

        const amountIn = ethers.parseEther('1');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'RouterNotApproved');
      });

      it('should revert on zero amountOutMin (no slippage protection)', async () => {
        const { daiArbitrage, dexRouter1, dai, weth, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        const amountIn = ethers.parseEther('1');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 0n, // No slippage protection!
          },
        ];
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InsufficientSlippageProtection');
      });

      it('should revert when paused', async () => {
        const { daiArbitrage, dai, dexRouter1, owner, user } = await loadFixture(
          deployContractsFixture
        );

        await daiArbitrage.connect(owner).pause();
        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        const amountIn = ethers.parseEther('1');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWith('Pausable: paused');
      });

      it('should revert if flash loan fails', async () => {
        const {
          daiArbitrage,
          dssFlash,
          dexRouter1,
          dai,
          weth,
          owner,
          user,
        } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

        // Set DssFlash to fail flash loans
        await dssFlash.setShouldFailFlashLoan(true);

        await dexRouter1.setExchangeRate(
          await dai.getAddress(),
          await weth.getAddress(),
          ethers.parseEther('0.0005')
        );
        await dexRouter1.setExchangeRate(
          await weth.getAddress(),
          await dai.getAddress(),
          ethers.parseEther('2100')
        );

        const amountIn = ethers.parseEther('1000');
        const swapPath = [
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await dai.getAddress(),
            tokenOut: await weth.getAddress(),
            amountOutMin: 1n,
          },
          {
            router: await dexRouter1.getAddress(),
            tokenIn: await weth.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const deadline = await getDeadline();

        await expect(
          daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
        ).to.be.revertedWithCustomError(daiArbitrage, 'FlashLoanFailed');
      });
    });

    describe('onFlashLoan() callback', () => {
      it('should revert if caller is not DssFlash', async () => {
        const { daiArbitrage, dai, attacker } = await loadFixture(
          deployContractsFixture
        );

        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await dai.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];

        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
          [swapPath, 0n]
        );

        await expect(
          daiArbitrage
            .connect(attacker)
            .onFlashLoan(attacker.address, await dai.getAddress(), ethers.parseEther('1'), 0, data)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidFlashLoanCaller');
      });

      it('should revert with InvalidFlashLoanInitiator when initiator is not the contract', async () => {
        const { daiArbitrage, dssFlash, dai, owner, attacker } = await loadFixture(
          deployContractsFixture
        );

        // Impersonate the DssFlash to bypass the caller check (msg.sender == DSS_FLASH),
        // then provide a wrong initiator to trigger the initiator check.
        const dssFlashAddress = await dssFlash.getAddress();
        await ethers.provider.send('hardhat_impersonateAccount', [dssFlashAddress]);
        await owner.sendTransaction({ to: dssFlashAddress, value: ethers.parseEther('1') });
        const dssFlashSigner = await ethers.getSigner(dssFlashAddress);

        const swapPath = [
          {
            router: ethers.ZeroAddress,
            tokenIn: await dai.getAddress(),
            tokenOut: await dai.getAddress(),
            amountOutMin: 1n,
          },
        ];
        const data = ethers.AbiCoder.defaultAbiCoder().encode(
          ['tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]', 'uint256'],
          [swapPath, 0n]
        );

        // Call onFlashLoan from the DssFlash with attacker as initiator (not the contract itself)
        await expect(
          daiArbitrage.connect(dssFlashSigner).onFlashLoan(
            attacker.address, // Wrong initiator - should be the contract address
            await dai.getAddress(),
            ethers.parseEther('1'),
            0,
            data
          )
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidFlashLoanInitiator');

        await ethers.provider.send('hardhat_stopImpersonatingAccount', [dssFlashAddress]);
      });
    });
  });

  // ==========================================================================
  // 4. Pause Functionality Tests
  // ==========================================================================
  describe('4. Pause Functionality', () => {
    it('should allow owner to pause', async () => {
      const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).pause();

      expect(await daiArbitrage.paused()).to.be.true;
    });

    it('should allow owner to unpause', async () => {
      const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).pause();
      await daiArbitrage.connect(owner).unpause();

      expect(await daiArbitrage.paused()).to.be.false;
    });

    it('should revert if non-owner tries to pause', async () => {
      const { daiArbitrage, user } = await loadFixture(deployContractsFixture);

      await expect(
        daiArbitrage.connect(user).pause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should revert if non-owner tries to unpause', async () => {
      const { daiArbitrage, owner, user } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).pause();

      await expect(
        daiArbitrage.connect(user).unpause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  // ==========================================================================
  // 5. Owner-Only Admin Functions Tests
  // ==========================================================================
  describe('5. Owner-Only Admin Functions', () => {
    describe('setMinimumProfit()', () => {
      it('should allow owner to set minimum profit', async () => {
        const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).setMinimumProfit(ethers.parseEther('0.01'));

        expect(await daiArbitrage.minimumProfit()).to.equal(ethers.parseEther('0.01'));
      });

      it('should revert on zero minimum profit', async () => {
        const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(owner).setMinimumProfit(0)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidMinimumProfit');
      });

      it('should revert if non-owner tries to set', async () => {
        const { daiArbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(user).setMinimumProfit(1)
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('withdrawToken()', () => {
      it('should allow owner to withdraw tokens', async () => {
        const { daiArbitrage, dai, owner } = await loadFixture(deployContractsFixture);

        // Mint some DAI to the contract
        const amount = ethers.parseEther('100');
        await dai.mint(await daiArbitrage.getAddress(), amount);

        await daiArbitrage.connect(owner).withdrawToken(
          await dai.getAddress(),
          owner.address,
          amount
        );

        expect(await dai.balanceOf(await daiArbitrage.getAddress())).to.equal(0);
      });

      it('should revert if non-owner tries to withdraw', async () => {
        const { daiArbitrage, dai, user } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(user).withdrawToken(
            await dai.getAddress(),
            user.address,
            ethers.parseEther('1')
          )
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });

      it('should revert on zero recipient address', async () => {
        const { daiArbitrage, dai, owner } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(owner).withdrawToken(
            await dai.getAddress(),
            ethers.ZeroAddress,
            1
          )
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidRecipient');
      });
    });

    describe('setSwapDeadline()', () => {
      it('should allow owner to set swap deadline', async () => {
        const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

        await daiArbitrage.connect(owner).setSwapDeadline(120);

        expect(await daiArbitrage.swapDeadline()).to.equal(120);
      });

      it('should revert on zero deadline', async () => {
        const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(owner).setSwapDeadline(0)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidSwapDeadline');
      });

      it('should revert on deadline exceeding max', async () => {
        const { daiArbitrage, owner } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(owner).setSwapDeadline(601)
        ).to.be.revertedWithCustomError(daiArbitrage, 'InvalidSwapDeadline');
      });

      it('should revert if non-owner tries to set', async () => {
        const { daiArbitrage, user } = await loadFixture(deployContractsFixture);

        await expect(
          daiArbitrage.connect(user).setSwapDeadline(120)
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
    });
  });

  // ==========================================================================
  // 6. Calculate Expected Profit Tests
  // ==========================================================================
  describe('6. Calculate Expected Profit', () => {
    it('should calculate expected profit correctly', async () => {
      const {
        daiArbitrage,
        dssFlash,
        dexRouter1,
        dai,
        weth,
        owner,
      } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure profitable rates
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005')
      );
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await dai.getAddress(),
        ethers.parseEther('2100')
      );

      const amount = ethers.parseEther('10000');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const [expectedProfit, flashLoanFee] = await daiArbitrage.calculateExpectedProfit(
        amount,
        swapPath
      );

      // Flash loan fee: 10000 * 1 / 10000 = 1 DAI
      expect(flashLoanFee).to.equal(ethers.parseEther('1'));
      // Expected profit should be positive
      expect(expectedProfit).to.be.gt(0);
    });

    it('should return zero profit for unprofitable path', async () => {
      const {
        daiArbitrage,
        dexRouter1,
        dai,
        weth,
        owner,
      } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      // Configure unprofitable rates (round-trip loses money)
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005')
      );
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await dai.getAddress(),
        ethers.parseEther('1900') // Only 1900 DAI back instead of 2000+
      );

      const amount = ethers.parseEther('10000');
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const [expectedProfit] = await daiArbitrage.calculateExpectedProfit(amount, swapPath);

      expect(expectedProfit).to.equal(0);
    });
  });

  // ==========================================================================
  // 7. Multi-hop Swap Execution
  // ==========================================================================
  describe('7. Multi-hop Swap Execution', () => {
    it('should execute 3-hop triangular arbitrage (DAI -> WETH -> USDC -> DAI)', async () => {
      const {
        daiArbitrage,
        dexRouter1,
        dexRouter2,
        dai,
        weth,
        usdc,
        owner,
        user,
      } = await loadFixture(deployContractsFixture);

      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await daiArbitrage.connect(owner).addApprovedRouter(await dexRouter2.getAddress());

      // Configure triangular rates: DAI -> WETH -> USDC -> DAI
      // Leg 1: DAI -> WETH on router1 (1 DAI = 0.0005 WETH)
      await dexRouter1.setExchangeRate(
        await dai.getAddress(),
        await weth.getAddress(),
        ethers.parseEther('0.0005')
      );
      // Leg 2: WETH -> USDC on router1 (1 WETH = 2000 USDC)
      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      // Leg 3: USDC -> DAI on router2 (1 USDC = 1.06 DAI — profitable)
      await dexRouter2.setExchangeRate(
        await usdc.getAddress(),
        await dai.getAddress(),
        BigInt('1060000000000000000000000000000') // 1.06 DAI per USDC adjusted for 6->18 decimals
      );

      const amountIn = ethers.parseEther('10000'); // 10000 DAI
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(),
          tokenOut: await weth.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter2.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: await dai.getAddress(),
          amountOutMin: 1n,
        },
      ];

      const deadline = await getDeadline();

      await expect(
        daiArbitrage.connect(user).executeArbitrage(amountIn, swapPath, 0n, deadline)
      ).to.emit(daiArbitrage, 'ArbitrageExecuted');

      // Verify profit was recorded
      expect(await daiArbitrage.totalProfits()).to.be.gt(0);
    });
  });
});
