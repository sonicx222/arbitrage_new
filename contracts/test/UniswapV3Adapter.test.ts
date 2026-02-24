import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import {
  UniswapV3Adapter,
  MockUniswapV3Router,
  MockQuoterV2,
  MockERC20,
  MockAavePool,
  FlashLoanArbitrage,
} from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { deployTokens, getDeadline, type DeployedTokens } from './helpers';

/**
 * UniswapV3Adapter Contract Tests
 *
 * Comprehensive test suite for the V3-to-V2 adapter that enables
 * BaseFlashArbitrage to use Uniswap V3 liquidity without modifications.
 *
 * Test categories:
 * - Deployment: constructor validation, initial state
 * - swapExactTokensForTokens: 2-hop, multi-hop, slippage, fee overrides
 * - swapTokensForExactTokens: basic forwarding
 * - getAmountsOut: quoter-based quoting
 * - getAmountsIn: reverse quoting
 * - Admin functions: setPairFee, setDefaultFee, setQuoter (access control)
 * - Integration: adapter as approved router in FlashLoanArbitrage
 * - Edge cases: empty path, single-element path, deadline passthrough
 */
describe('UniswapV3Adapter', () => {
  // Default fee: 3000 = 0.3%
  const DEFAULT_FEE = 3000;

  // Standard exchange rate: 1:1 for same-decimal tokens (1e18 rate = 1:1)
  const RATE_1_TO_1 = ethers.parseEther('1');

  // Profitable rate: 1 WETH = 1.05 DAI (5% profit for testing)
  const RATE_WETH_TO_DAI = ethers.parseEther('1.05');

  // Reverse rate: 1 DAI = 0.96 WETH (slight loss on reverse, net profitable with forward)
  const RATE_DAI_TO_WETH = ethers.parseEther('0.96');

  // Rate for multi-hop: WETH -> USDC (18 dec -> 6 dec)
  // 1 WETH (1e18) * rate / 1e18 = 2000 USDC (2000e6)
  const RATE_WETH_TO_USDC = ethers.parseUnits('2000', 6);

  // Rate for multi-hop: USDC -> DAI (6 dec -> 18 dec)
  // 1 USDC (1e6) * rate / 1e18 = 1.01 DAI (1.01e18)
  // rate = 1.01e18 * 1e18 / 1e6 = 1.01e30
  const RATE_USDC_TO_DAI = BigInt('1010000000000000000000000000000');

  // ==========================================================================
  // Fixture
  // ==========================================================================

  async function deployAdapterFixture() {
    const [owner, user, attacker] = await ethers.getSigners();

    // Deploy tokens
    const tokens = await deployTokens();
    const { weth, usdc, dai } = tokens;

    // Deploy V3 mock router
    const MockV3RouterFactory = await ethers.getContractFactory('MockUniswapV3Router');
    const v3Router = await MockV3RouterFactory.deploy();

    // Deploy mock quoter
    const MockQuoterFactory = await ethers.getContractFactory('MockQuoterV2');
    const quoter = await MockQuoterFactory.deploy();

    // Deploy adapter
    const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
    const adapter = await AdapterFactory.deploy(
      await v3Router.getAddress(),
      await quoter.getAddress(),
      owner.address,
      DEFAULT_FEE,
    );

    // Get addresses
    const wethAddr = await weth.getAddress();
    const daiAddr = await dai.getAddress();
    const usdcAddr = await usdc.getAddress();
    const v3RouterAddr = await v3Router.getAddress();
    const adapterAddr = await adapter.getAddress();

    // Set up exchange rates on V3 router
    await v3Router.setExchangeRate(wethAddr, daiAddr, RATE_WETH_TO_DAI);
    await v3Router.setExchangeRate(daiAddr, wethAddr, RATE_DAI_TO_WETH);
    await v3Router.setExchangeRate(wethAddr, usdcAddr, RATE_WETH_TO_USDC);
    await v3Router.setExchangeRate(usdcAddr, daiAddr, RATE_USDC_TO_DAI);

    // Set up exchange rates on quoter (same rates)
    await quoter.setExchangeRate(wethAddr, daiAddr, RATE_WETH_TO_DAI);
    await quoter.setExchangeRate(daiAddr, wethAddr, RATE_DAI_TO_WETH);
    await quoter.setExchangeRate(wethAddr, usdcAddr, RATE_WETH_TO_USDC);
    await quoter.setExchangeRate(usdcAddr, daiAddr, RATE_USDC_TO_DAI);

    // Fund V3 router with output tokens
    await weth.mint(v3RouterAddr, ethers.parseEther('10000'));
    await dai.mint(v3RouterAddr, ethers.parseEther('10000'));
    await usdc.mint(v3RouterAddr, ethers.parseUnits('10000000', 6));

    // Mint tokens to owner for swap tests
    await weth.mint(owner.address, ethers.parseEther('1000'));
    await dai.mint(owner.address, ethers.parseEther('1000'));
    await usdc.mint(owner.address, ethers.parseUnits('100000', 6));

    // Approve adapter to spend owner's tokens
    await weth.approve(adapterAddr, ethers.MaxUint256);
    await dai.approve(adapterAddr, ethers.MaxUint256);
    await usdc.approve(adapterAddr, ethers.MaxUint256);

    return {
      adapter,
      v3Router,
      quoter,
      weth,
      usdc,
      dai,
      owner,
      user,
      attacker,
      wethAddr,
      daiAddr,
      usdcAddr,
      v3RouterAddr,
      adapterAddr,
    };
  }

  // ==========================================================================
  // Deployment Tests
  // ==========================================================================

  describe('Deployment', () => {
    it('should deploy with correct owner', async () => {
      const { adapter, owner } = await loadFixture(deployAdapterFixture);
      expect(await adapter.owner()).to.equal(owner.address);
    });

    it('should set correct V3 router address', async () => {
      const { adapter, v3RouterAddr } = await loadFixture(deployAdapterFixture);
      expect(await adapter.v3Router()).to.equal(v3RouterAddr);
    });

    it('should set correct default fee', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);
      expect(await adapter.defaultFee()).to.equal(DEFAULT_FEE);
    });

    it('should set correct quoter address', async () => {
      const { adapter, quoter } = await loadFixture(deployAdapterFixture);
      expect(await adapter.quoter()).to.equal(await quoter.getAddress());
    });

    it('should return address(0) for factory()', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);
      expect(await adapter.factory()).to.equal(ethers.ZeroAddress);
    });

    it('should return address(0) for WETH()', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);
      expect(await adapter.WETH()).to.equal(ethers.ZeroAddress);
    });

    it('should revert on zero V3 router address', async () => {
      const [owner] = await ethers.getSigners();
      const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
      await expect(
        AdapterFactory.deploy(ethers.ZeroAddress, ethers.ZeroAddress, owner.address, DEFAULT_FEE),
      ).to.be.revertedWith('V3 router is zero address');
    });

    it('should revert on zero owner address', async () => {
      const { v3RouterAddr } = await loadFixture(deployAdapterFixture);
      const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
      await expect(
        AdapterFactory.deploy(v3RouterAddr, ethers.ZeroAddress, ethers.ZeroAddress, DEFAULT_FEE),
      ).to.be.revertedWith('Owner is zero address');
    });

    it('should revert on zero default fee', async () => {
      const [owner] = await ethers.getSigners();
      const { v3RouterAddr } = await loadFixture(deployAdapterFixture);
      const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
      await expect(
        AdapterFactory.deploy(v3RouterAddr, ethers.ZeroAddress, owner.address, 0),
      ).to.be.revertedWith('Default fee must be > 0');
    });

    it('should allow zero quoter address (quoting disabled)', async () => {
      const [owner] = await ethers.getSigners();
      const { v3RouterAddr } = await loadFixture(deployAdapterFixture);
      const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
      const adapterNoQuoter = await AdapterFactory.deploy(
        v3RouterAddr,
        ethers.ZeroAddress,
        owner.address,
        DEFAULT_FEE,
      );
      expect(await adapterNoQuoter.quoter()).to.equal(ethers.ZeroAddress);
    });
  });

  // ==========================================================================
  // swapExactTokensForTokens Tests
  // ==========================================================================

  describe('swapExactTokensForTokens', () => {
    it('should execute a 2-token path swap correctly', async () => {
      const { adapter, weth, dai, wethAddr, daiAddr, owner, adapterAddr } =
        await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('10');
      const deadline = await getDeadline();

      const wethBefore = await weth.balanceOf(owner.address);
      const daiBefore = await dai.balanceOf(owner.address);

      const tx = await adapter.swapExactTokensForTokens(
        amountIn,
        0, // no minimum
        [wethAddr, daiAddr],
        owner.address,
        deadline,
      );

      const wethAfter = await weth.balanceOf(owner.address);
      const daiAfter = await dai.balanceOf(owner.address);

      // WETH decreased by amountIn
      expect(wethBefore - wethAfter).to.equal(amountIn);

      // DAI increased by expected amount: (10e18 * 1.05e18) / 1e18 = 10.5e18
      const expectedDai = ethers.parseEther('10.5');
      expect(daiAfter - daiBefore).to.equal(expectedDai);
    });

    it('should return correct amounts array for 2-token path', async () => {
      const { adapter, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('10');
      const deadline = await getDeadline();

      const result = await adapter.swapExactTokensForTokens.staticCall(
        amountIn,
        0,
        [wethAddr, daiAddr],
        (await ethers.getSigners())[0].address,
        deadline,
      );

      expect(result.length).to.equal(2);
      expect(result[0]).to.equal(amountIn);
      expect(result[1]).to.equal(ethers.parseEther('10.5'));
    });

    it('should translate V2 call to V3 exactInputSingle', async () => {
      const { adapter, v3Router, wethAddr, daiAddr, owner } =
        await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('5');
      const deadline = await getDeadline();

      await adapter.swapExactTokensForTokens(
        amountIn,
        0,
        [wethAddr, daiAddr],
        owner.address,
        deadline,
      );

      // Verify V3 router received the correct fee
      expect(await v3Router.lastFee()).to.equal(DEFAULT_FEE);
    });

    it('should execute multi-hop path (3 tokens, 2 hops)', async () => {
      const { adapter, weth, dai, wethAddr, usdcAddr, daiAddr, owner } =
        await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('1');
      const deadline = await getDeadline();

      const daiBefore = await dai.balanceOf(owner.address);

      const result = await adapter.swapExactTokensForTokens.staticCall(
        amountIn,
        0,
        [wethAddr, usdcAddr, daiAddr],
        owner.address,
        deadline,
      );

      // Hop 1: 1 WETH -> USDC: (1e18 * 2000e6) / 1e18 = 2000e6 USDC
      expect(result[0]).to.equal(amountIn);
      expect(result[1]).to.equal(ethers.parseUnits('2000', 6));

      // Hop 2: 2000 USDC -> DAI: (2000e6 * 1.01e30) / 1e18 = 2020e18 DAI
      expect(result[2]).to.equal(ethers.parseEther('2020'));

      // Execute the actual swap
      await adapter.swapExactTokensForTokens(
        amountIn,
        0,
        [wethAddr, usdcAddr, daiAddr],
        owner.address,
        deadline,
      );

      const daiAfter = await dai.balanceOf(owner.address);
      expect(daiAfter - daiBefore).to.equal(ethers.parseEther('2020'));
    });

    it('should respect amountOutMin (revert on insufficient output)', async () => {
      const { adapter, wethAddr, daiAddr, owner } = await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('10');
      // Expected output is 10.5 DAI, set min to 11 DAI -> should revert
      const tooHighMin = ethers.parseEther('11');
      const deadline = await getDeadline();

      await expect(
        adapter.swapExactTokensForTokens(
          amountIn,
          tooHighMin,
          [wethAddr, daiAddr],
          owner.address,
          deadline,
        ),
      ).to.be.revertedWithCustomError(adapter, 'InsufficientOutputAmount');
    });

    it('should use per-pair fee override when set', async () => {
      const { adapter, v3Router, wethAddr, daiAddr, owner } =
        await loadFixture(deployAdapterFixture);

      const customFee = 500; // 0.05%
      await adapter.setPairFee(wethAddr, daiAddr, customFee);

      const amountIn = ethers.parseEther('10');
      const deadline = await getDeadline();

      await adapter.swapExactTokensForTokens(
        amountIn,
        0,
        [wethAddr, daiAddr],
        owner.address,
        deadline,
      );

      // V3 router should have received the custom fee
      expect(await v3Router.lastFee()).to.equal(customFee);
    });

    it('should use default fee when no override exists', async () => {
      const { adapter, v3Router, wethAddr, daiAddr, owner } =
        await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('10');
      const deadline = await getDeadline();

      await adapter.swapExactTokensForTokens(
        amountIn,
        0,
        [wethAddr, daiAddr],
        owner.address,
        deadline,
      );

      expect(await v3Router.lastFee()).to.equal(DEFAULT_FEE);
    });

    it('should pass deadline to V3 router', async () => {
      const { adapter, v3Router, wethAddr, daiAddr, owner } =
        await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('1');
      const deadline = await getDeadline(600);

      await adapter.swapExactTokensForTokens(
        amountIn,
        0,
        [wethAddr, daiAddr],
        owner.address,
        deadline,
      );

      expect(await v3Router.lastDeadline()).to.equal(deadline);
    });

    it('should send output tokens to specified recipient', async () => {
      const { adapter, dai, wethAddr, daiAddr, user } =
        await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('10');
      const deadline = await getDeadline();

      const userDaiBefore = await dai.balanceOf(user.address);

      await adapter.swapExactTokensForTokens(
        amountIn,
        0,
        [wethAddr, daiAddr],
        user.address, // send to user, not owner
        deadline,
      );

      const userDaiAfter = await dai.balanceOf(user.address);
      expect(userDaiAfter - userDaiBefore).to.equal(ethers.parseEther('10.5'));
    });
  });

  // ==========================================================================
  // swapTokensForExactTokens Tests
  // ==========================================================================

  describe('swapTokensForExactTokens', () => {
    it('should execute forward swap with max input', async () => {
      const { adapter, wethAddr, daiAddr, owner, dai } =
        await loadFixture(deployAdapterFixture);

      const amountInMax = ethers.parseEther('10');
      const amountOut = ethers.parseEther('10'); // Want at least 10 DAI
      const deadline = await getDeadline();

      const daiBefore = await dai.balanceOf(owner.address);

      // Execute swap: 10 WETH * 1.05 rate = 10.5 DAI output (>= 10 DAI requested)
      await adapter.swapTokensForExactTokens(
        amountOut,
        amountInMax,
        [wethAddr, daiAddr],
        owner.address,
        deadline,
      );

      const daiAfter = await dai.balanceOf(owner.address);
      expect(daiAfter - daiBefore).to.equal(ethers.parseEther('10.5'));
    });

    it('should revert when output is insufficient', async () => {
      const { adapter, wethAddr, daiAddr, owner } =
        await loadFixture(deployAdapterFixture);

      const amountInMax = ethers.parseEther('10');
      // Want 11 DAI but swap only produces 10.5 DAI
      const tooMuchOut = ethers.parseEther('11');
      const deadline = await getDeadline();

      await expect(
        adapter.swapTokensForExactTokens(
          tooMuchOut,
          amountInMax,
          [wethAddr, daiAddr],
          owner.address,
          deadline,
        ),
      ).to.be.revertedWithCustomError(adapter, 'InsufficientOutputAmount');
    });
  });

  // ==========================================================================
  // getAmountsOut Tests
  // ==========================================================================

  describe('getAmountsOut', () => {
    it('should return correct quoted amounts for 2-token path', async () => {
      const { adapter, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('10');
      const amounts = await adapter.getAmountsOut(amountIn, [wethAddr, daiAddr]);

      expect(amounts.length).to.equal(2);
      expect(amounts[0]).to.equal(amountIn);
      expect(amounts[1]).to.equal(ethers.parseEther('10.5'));
    });

    it('should return correct quoted amounts for multi-hop path', async () => {
      const { adapter, wethAddr, usdcAddr, daiAddr } =
        await loadFixture(deployAdapterFixture);

      const amountIn = ethers.parseEther('1');
      const amounts = await adapter.getAmountsOut(amountIn, [wethAddr, usdcAddr, daiAddr]);

      expect(amounts.length).to.equal(3);
      expect(amounts[0]).to.equal(amountIn);
      expect(amounts[1]).to.equal(ethers.parseUnits('2000', 6));
      expect(amounts[2]).to.equal(ethers.parseEther('2020'));
    });

    it('should revert when quoter is not configured', async () => {
      const [owner] = await ethers.getSigners();
      const { v3RouterAddr, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      // Deploy adapter without quoter
      const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
      const adapterNoQuoter = await AdapterFactory.deploy(
        v3RouterAddr,
        ethers.ZeroAddress,
        owner.address,
        DEFAULT_FEE,
      );

      await expect(
        adapterNoQuoter.getAmountsOut(ethers.parseEther('1'), [wethAddr, daiAddr]),
      ).to.be.revertedWithCustomError(adapterNoQuoter, 'QuoterNotConfigured');
    });

    it('should revert with path too short', async () => {
      const { adapter, wethAddr } = await loadFixture(deployAdapterFixture);

      await expect(
        adapter.getAmountsOut(ethers.parseEther('1'), [wethAddr]),
      ).to.be.revertedWithCustomError(adapter, 'PathTooShort');
    });
  });

  // ==========================================================================
  // getAmountsIn Tests
  // ==========================================================================

  describe('getAmountsIn', () => {
    it('should return estimated input amounts', async () => {
      const { adapter, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      const amountOut = ethers.parseEther('10');
      const amounts = await adapter.getAmountsIn(amountOut, [wethAddr, daiAddr]);

      expect(amounts.length).to.equal(2);
      expect(amounts[amounts.length - 1]).to.equal(amountOut);
      // Reverse quote: 10 DAI -> WETH using DAI->WETH rate (0.96)
      // amounts[0] = (10e18 * 0.96e18) / 1e18 = 9.6e18
      expect(amounts[0]).to.equal(ethers.parseEther('9.6'));
    });

    it('should revert when quoter is not configured', async () => {
      const [owner] = await ethers.getSigners();
      const { v3RouterAddr, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      const AdapterFactory = await ethers.getContractFactory('UniswapV3Adapter');
      const adapterNoQuoter = await AdapterFactory.deploy(
        v3RouterAddr,
        ethers.ZeroAddress,
        owner.address,
        DEFAULT_FEE,
      );

      await expect(
        adapterNoQuoter.getAmountsIn(ethers.parseEther('1'), [wethAddr, daiAddr]),
      ).to.be.revertedWithCustomError(adapterNoQuoter, 'QuoterNotConfigured');
    });
  });

  // ==========================================================================
  // Admin Functions Tests
  // ==========================================================================

  describe('setPairFee', () => {
    it('should allow owner to set pair fee', async () => {
      const { adapter, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      await adapter.setPairFee(wethAddr, daiAddr, 500);
      expect(await adapter.getFee(wethAddr, daiAddr)).to.equal(500);
    });

    it('should be order-independent (A,B same as B,A)', async () => {
      const { adapter, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      await adapter.setPairFee(wethAddr, daiAddr, 500);
      // Query in reverse order should return same fee
      expect(await adapter.getFee(daiAddr, wethAddr)).to.equal(500);
    });

    it('should emit PairFeeSet event', async () => {
      const { adapter, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      await expect(adapter.setPairFee(wethAddr, daiAddr, 10000))
        .to.emit(adapter, 'PairFeeSet')
        .withArgs(wethAddr, daiAddr, 10000);
    });

    it('should revert for non-owner', async () => {
      const { adapter, wethAddr, daiAddr, user } = await loadFixture(deployAdapterFixture);

      const userAdapter = adapter.connect(user) as UniswapV3Adapter;
      await expect(
        userAdapter.setPairFee(wethAddr, daiAddr, 500),
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should revert on zero address token', async () => {
      const { adapter, wethAddr } = await loadFixture(deployAdapterFixture);

      await expect(
        adapter.setPairFee(wethAddr, ethers.ZeroAddress, 500),
      ).to.be.revertedWithCustomError(adapter, 'ZeroAddress');
    });

    it('should revert on zero fee', async () => {
      const { adapter, wethAddr, daiAddr } = await loadFixture(deployAdapterFixture);

      await expect(
        adapter.setPairFee(wethAddr, daiAddr, 0),
      ).to.be.revertedWithCustomError(adapter, 'InvalidFeeTier');
    });
  });

  describe('setDefaultFee', () => {
    it('should allow owner to set default fee', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);

      await adapter.setDefaultFee(500);
      expect(await adapter.defaultFee()).to.equal(500);
    });

    it('should emit DefaultFeeSet event', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);

      await expect(adapter.setDefaultFee(10000))
        .to.emit(adapter, 'DefaultFeeSet')
        .withArgs(10000);
    });

    it('should revert for non-owner', async () => {
      const { adapter, user } = await loadFixture(deployAdapterFixture);

      const userAdapter = adapter.connect(user) as UniswapV3Adapter;
      await expect(userAdapter.setDefaultFee(500)).to.be.revertedWith(
        'Ownable: caller is not the owner',
      );
    });

    it('should revert on zero fee', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);

      await expect(adapter.setDefaultFee(0)).to.be.revertedWithCustomError(
        adapter,
        'InvalidFeeTier',
      );
    });
  });

  describe('setQuoter', () => {
    it('should allow owner to set quoter', async () => {
      const { adapter, quoter } = await loadFixture(deployAdapterFixture);
      const quoterAddr = await quoter.getAddress();

      // Deploy a new quoter and set it
      const MockQuoterFactory = await ethers.getContractFactory('MockQuoterV2');
      const newQuoter = await MockQuoterFactory.deploy();
      const newQuoterAddr = await newQuoter.getAddress();

      await adapter.setQuoter(newQuoterAddr);
      expect(await adapter.quoter()).to.equal(newQuoterAddr);
    });

    it('should emit QuoterSet event', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);
      const MockQuoterFactory = await ethers.getContractFactory('MockQuoterV2');
      const newQuoter = await MockQuoterFactory.deploy();
      const newQuoterAddr = await newQuoter.getAddress();

      await expect(adapter.setQuoter(newQuoterAddr))
        .to.emit(adapter, 'QuoterSet')
        .withArgs(newQuoterAddr);
    });

    it('should revert for non-owner', async () => {
      const { adapter, user } = await loadFixture(deployAdapterFixture);

      const userAdapter = adapter.connect(user) as UniswapV3Adapter;
      await expect(userAdapter.setQuoter(ethers.ZeroAddress)).to.be.revertedWith(
        'Ownable: caller is not the owner',
      );
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should revert on empty path for swapExactTokensForTokens', async () => {
      const { adapter, owner } = await loadFixture(deployAdapterFixture);
      const deadline = await getDeadline();

      await expect(
        adapter.swapExactTokensForTokens(ethers.parseEther('1'), 0, [], owner.address, deadline),
      ).to.be.revertedWithCustomError(adapter, 'PathTooShort');
    });

    it('should revert on single-element path for swapExactTokensForTokens', async () => {
      const { adapter, wethAddr, owner } = await loadFixture(deployAdapterFixture);
      const deadline = await getDeadline();

      await expect(
        adapter.swapExactTokensForTokens(
          ethers.parseEther('1'),
          0,
          [wethAddr],
          owner.address,
          deadline,
        ),
      ).to.be.revertedWithCustomError(adapter, 'PathTooShort');
    });

    it('should revert on empty path for swapTokensForExactTokens', async () => {
      const { adapter, owner } = await loadFixture(deployAdapterFixture);
      const deadline = await getDeadline();

      await expect(
        adapter.swapTokensForExactTokens(
          ethers.parseEther('1'),
          ethers.parseEther('1'),
          [],
          owner.address,
          deadline,
        ),
      ).to.be.revertedWithCustomError(adapter, 'PathTooShort');
    });

    it('should revert on empty path for getAmountsOut', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);

      await expect(
        adapter.getAmountsOut(ethers.parseEther('1'), []),
      ).to.be.revertedWithCustomError(adapter, 'PathTooShort');
    });

    it('should revert on empty path for getAmountsIn', async () => {
      const { adapter } = await loadFixture(deployAdapterFixture);

      await expect(
        adapter.getAmountsIn(ethers.parseEther('1'), []),
      ).to.be.revertedWithCustomError(adapter, 'PathTooShort');
    });

    it('should use getFee to retrieve per-pair and default fees', async () => {
      const { adapter, wethAddr, daiAddr, usdcAddr } = await loadFixture(deployAdapterFixture);

      // No override: should return default
      expect(await adapter.getFee(wethAddr, daiAddr)).to.equal(DEFAULT_FEE);

      // Set override
      await adapter.setPairFee(wethAddr, daiAddr, 500);
      expect(await adapter.getFee(wethAddr, daiAddr)).to.equal(500);

      // Other pair still uses default
      expect(await adapter.getFee(wethAddr, usdcAddr)).to.equal(DEFAULT_FEE);
    });
  });

  // ==========================================================================
  // Integration: Adapter as Approved Router in FlashLoanArbitrage
  // ==========================================================================

  describe('Integration with FlashLoanArbitrage', () => {
    async function deployIntegrationFixture() {
      const base = await deployAdapterFixture();
      const { adapter, v3Router, weth, dai, wethAddr, daiAddr, owner } = base;

      // Deploy Aave pool mock
      const MockAavePoolFactory = await ethers.getContractFactory('MockAavePool');
      const aavePool = await MockAavePoolFactory.deploy();
      const aavePoolAddr = await aavePool.getAddress();

      // Fund Aave pool with WETH for flash loans
      await weth.mint(aavePoolAddr, ethers.parseEther('10000'));

      // Deploy FlashLoanArbitrage
      const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
      const flashLoan = await FlashLoanArbitrageFactory.deploy(aavePoolAddr, owner.address);
      const flashLoanAddr = await flashLoan.getAddress();

      // Approve adapter as router in FlashLoanArbitrage
      const adapterAddr = await adapter.getAddress();
      await flashLoan.addApprovedRouter(adapterAddr);

      // The FlashLoanArbitrage contract needs tokens approved from adapter
      // V3 router needs to be funded (already done in base fixture)

      // Set profitable round-trip rates:
      // WETH -> DAI at 1.05 rate
      // DAI -> WETH at 1.0 rate (net: 1 WETH -> 1.05 DAI -> 1.05 WETH = 5% profit before fees)
      const profitableReverseRate = ethers.parseEther('1.0');
      await v3Router.setExchangeRate(daiAddr, wethAddr, profitableReverseRate);

      // Fund V3 router with extra WETH and DAI for the round-trip
      const v3RouterAddr = await v3Router.getAddress();
      await weth.mint(v3RouterAddr, ethers.parseEther('10000'));
      await dai.mint(v3RouterAddr, ethers.parseEther('10000'));

      return { ...base, aavePool, flashLoan, flashLoanAddr };
    }

    it('should verify adapter is approved router', async () => {
      const { flashLoan, adapterAddr } = await loadFixture(deployIntegrationFixture);

      expect(await flashLoan.isApprovedRouter(adapterAddr)).to.be.true;
    });

    it('should execute arbitrage through adapter', async () => {
      const { flashLoan, weth, wethAddr, daiAddr, adapterAddr, owner } =
        await loadFixture(deployIntegrationFixture);

      const flashLoanAddr = await flashLoan.getAddress();
      const flashAmount = ethers.parseEther('100');
      const deadline = await getDeadline();

      // Swap path: WETH -> DAI -> WETH (round trip through adapter)
      // amountOutMin must be non-zero (BaseFlashArbitrage enforces slippage protection)
      const swapPath = [
        {
          router: adapterAddr,
          tokenIn: wethAddr,
          tokenOut: daiAddr,
          amountOutMin: 1n, // Non-zero for slippage protection validation
        },
        {
          router: adapterAddr,
          tokenIn: daiAddr,
          tokenOut: wethAddr,
          amountOutMin: 1n, // Non-zero for slippage protection validation
        },
      ];

      // Execute arbitrage
      // Flash loan: 100 WETH
      // Hop 1: 100 WETH -> 105 DAI (1.05 rate)
      // Hop 2: 105 DAI -> 105 WETH (1.0 rate)
      // Repay: 100 WETH + 0.09 WETH (0.09% Aave fee) = 100.09 WETH
      // Profit: 105 - 100.09 = 4.91 WETH
      await flashLoan.executeArbitrage(
        wethAddr,
        flashAmount,
        swapPath,
        1, // minProfit = 1 wei (just verify profitability)
        deadline,
      );

      // Verify contract has profit
      const contractBalance = await weth.balanceOf(flashLoanAddr);
      expect(contractBalance).to.be.gt(0);
    });
  });
});
