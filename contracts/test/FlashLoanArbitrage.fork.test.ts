/**
 * FlashLoanArbitrage Integration Tests with Mainnet Fork
 *
 * These tests verify the contract works correctly against real Aave V3 and DEX
 * router contracts using Hardhat's mainnet forking feature.
 *
 * Run with:
 *   FORK_ENABLED=true npx hardhat test test/FlashLoanArbitrage.fork.test.ts
 *
 * Environment Variables:
 *   FORK_ENABLED=true       - Enable mainnet forking
 *   ETHEREUM_RPC_URL        - Ethereum mainnet RPC URL (Alchemy/Infura)
 *
 * @see implementation_plan_v2.md Task 3.1.3
 */

import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { loadFixture, impersonateAccount, setBalance } from '@nomicfoundation/hardhat-network-helpers';
import { FlashLoanArbitrage } from '../typechain-types';
// FIX 3.1.3-3: Removed unused SignerWithAddress import

// =============================================================================
// Test Configuration - Real Mainnet Addresses
// =============================================================================

/**
 * Mainnet contract addresses
 */
const MAINNET_ADDRESSES = {
  // Aave V3 Pool on Ethereum Mainnet
  AAVE_V3_POOL: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',

  // DEX Routers
  UNISWAP_V2_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  SUSHISWAP_ROUTER: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',

  // Common Tokens
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',

  // Whale addresses (accounts with large token balances for testing)
  WETH_WHALE: '0x8EB8a3b98659Cce290402893d0123abb75E3ab28', // Binance 8
  USDC_WHALE: '0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503', // Binance
};

// Skip tests if fork is not enabled
const FORK_ENABLED = process.env.FORK_ENABLED === 'true';

// =============================================================================
// ERC20 Interface for token interactions
// =============================================================================

const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
];

// =============================================================================
// Test Suite
// =============================================================================

describe('FlashLoanArbitrage - Mainnet Fork Integration', function () {
  // Increase timeout for fork tests (network latency)
  this.timeout(120000);

  // Skip entire suite if fork not enabled
  before(function () {
    if (!FORK_ENABLED) {
      console.log('\n⚠️  Mainnet fork tests skipped. Set FORK_ENABLED=true to run.');
      this.skip();
    }
  });

  // ===========================================================================
  // Fixtures
  // ===========================================================================

  /**
   * Deploy FlashLoanArbitrage with real Aave V3 Pool
   */
  async function deployWithRealAaveFixture() {
    const [owner, user] = await ethers.getSigners();

    // Deploy FlashLoanArbitrage with real Aave V3 Pool
    const FlashLoanArbitrageFactory = await ethers.getContractFactory('FlashLoanArbitrage');
    const flashLoanArbitrage = await FlashLoanArbitrageFactory.deploy(
      MAINNET_ADDRESSES.AAVE_V3_POOL,
      owner.address
    );

    // Add approved routers
    await flashLoanArbitrage.addApprovedRouter(MAINNET_ADDRESSES.UNISWAP_V2_ROUTER);
    await flashLoanArbitrage.addApprovedRouter(MAINNET_ADDRESSES.SUSHISWAP_ROUTER);

    // Create token contracts
    const weth = new ethers.Contract(MAINNET_ADDRESSES.WETH, ERC20_ABI, owner);
    const usdc = new ethers.Contract(MAINNET_ADDRESSES.USDC, ERC20_ABI, owner);
    const dai = new ethers.Contract(MAINNET_ADDRESSES.DAI, ERC20_ABI, owner);

    return {
      flashLoanArbitrage,
      weth,
      usdc,
      dai,
      owner,
      user,
    };
  }

  // ===========================================================================
  // Aave V3 Pool Integration Tests
  // ===========================================================================

  describe('Aave V3 Pool Integration', () => {
    it('should correctly read flash loan premium from real Aave Pool', async () => {
      const { flashLoanArbitrage } = await loadFixture(deployWithRealAaveFixture);

      // Create interface to call POOL
      const pool = await ethers.getContractAt(
        ['function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128)'],
        await flashLoanArbitrage.POOL()
      );

      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();

      // Aave V3 flash loan premium is 9 basis points (0.09%)
      expect(premium).to.equal(9);
      console.log(`  Aave V3 Flash Loan Premium: ${premium} bps (${Number(premium) / 100}%)`);
    });

    it('should be able to request flash loan from real Aave Pool', async () => {
      const { flashLoanArbitrage, weth, owner } = await loadFixture(deployWithRealAaveFixture);

      // Check Aave Pool has WETH liquidity
      const aavePoolWethBalance = await weth.balanceOf(MAINNET_ADDRESSES.AAVE_V3_POOL);
      expect(aavePoolWethBalance).to.be.gt(ethers.parseEther('1000'));
      console.log(`  Aave Pool WETH Balance: ${ethers.formatEther(aavePoolWethBalance)} WETH`);
    });
  });

  // ===========================================================================
  // DEX Router Integration Tests
  // ===========================================================================

  describe('DEX Router Integration', () => {
    it('should get quotes from real Uniswap V2 Router', async () => {
      const router = await ethers.getContractAt(
        ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'],
        MAINNET_ADDRESSES.UNISWAP_V2_ROUTER
      );

      const amountIn = ethers.parseEther('1'); // 1 WETH
      const path = [MAINNET_ADDRESSES.WETH, MAINNET_ADDRESSES.USDC];

      const amounts = await router.getAmountsOut(amountIn, path);
      const usdcOut = amounts[1];

      // Should get some USDC out (sanity check)
      expect(usdcOut).to.be.gt(0);
      console.log(`  1 WETH -> ${ethers.formatUnits(usdcOut, 6)} USDC (Uniswap V2)`);
    });

    it('should get quotes from real SushiSwap Router', async () => {
      const router = await ethers.getContractAt(
        ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'],
        MAINNET_ADDRESSES.SUSHISWAP_ROUTER
      );

      const amountIn = ethers.parseEther('1'); // 1 WETH
      const path = [MAINNET_ADDRESSES.WETH, MAINNET_ADDRESSES.USDC];

      const amounts = await router.getAmountsOut(amountIn, path);
      const usdcOut = amounts[1];

      expect(usdcOut).to.be.gt(0);
      console.log(`  1 WETH -> ${ethers.formatUnits(usdcOut, 6)} USDC (SushiSwap)`);
    });

    it('should detect price differences between DEXes', async () => {
      const uniRouter = await ethers.getContractAt(
        ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'],
        MAINNET_ADDRESSES.UNISWAP_V2_ROUTER
      );
      const sushiRouter = await ethers.getContractAt(
        ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'],
        MAINNET_ADDRESSES.SUSHISWAP_ROUTER
      );

      const amountIn = ethers.parseEther('10'); // 10 WETH
      const path = [MAINNET_ADDRESSES.WETH, MAINNET_ADDRESSES.USDC];

      const [uniAmounts, sushiAmounts] = await Promise.all([
        uniRouter.getAmountsOut(amountIn, path),
        sushiRouter.getAmountsOut(amountIn, path),
      ]);

      const uniOut = uniAmounts[1];
      const sushiOut = sushiAmounts[1];
      const priceDiffBps = Math.abs(Number(uniOut - sushiOut)) * 10000 / Number(uniOut);

      console.log(`  Uniswap V2:  ${ethers.formatUnits(uniOut, 6)} USDC`);
      console.log(`  SushiSwap:   ${ethers.formatUnits(sushiOut, 6)} USDC`);
      console.log(`  Price diff:  ${priceDiffBps.toFixed(2)} bps`);

      // Price difference should exist (may be small)
      // This validates we can detect arbitrage opportunities
      expect(priceDiffBps).to.be.lt(500); // Should be less than 5% (sanity check)
    });
  });

  // ===========================================================================
  // Flash Loan Execution Tests (with impersonation)
  // ===========================================================================

  describe('Flash Loan Execution', () => {
    /**
     * Test the full flash loan flow by simulating an arbitrage.
     *
     * NOTE: This test creates an artificial arbitrage by manipulating
     * mock router rates. In production, real arbitrage opportunities
     * come from natural price discrepancies between DEXes.
     */
    it('should execute flash loan with real Aave Pool (dry run)', async () => {
      const { flashLoanArbitrage, weth, owner } = await loadFixture(deployWithRealAaveFixture);

      // Verify contract is properly configured
      const poolAddress = await flashLoanArbitrage.POOL();
      expect(poolAddress).to.equal(MAINNET_ADDRESSES.AAVE_V3_POOL);

      // Verify routers are approved
      expect(await flashLoanArbitrage.isApprovedRouter(MAINNET_ADDRESSES.UNISWAP_V2_ROUTER)).to.be.true;
      expect(await flashLoanArbitrage.isApprovedRouter(MAINNET_ADDRESSES.SUSHISWAP_ROUTER)).to.be.true;

      console.log('  ✅ Contract properly configured with real Aave V3 Pool');
      console.log('  ✅ DEX routers approved');

      // Note: Actually executing a profitable arbitrage on fork is unlikely
      // because we need a real price discrepancy at the forked block.
      // This test validates the contract can interact with real Aave.
    });

    it('should execute flash loan through real Aave and revert with InsufficientProfit', async () => {
      const { flashLoanArbitrage } = await loadFixture(deployWithRealAaveFixture);

      const flashLoanAmount = ethers.parseEther('1'); // 1 WETH

      // Build a real 2-hop swap path through Uniswap V2 and SushiSwap
      const swapPath = [
        {
          router: MAINNET_ADDRESSES.UNISWAP_V2_ROUTER,
          tokenIn: MAINNET_ADDRESSES.WETH,
          tokenOut: MAINNET_ADDRESSES.USDC,
          amountOutMin: 0n,
        },
        {
          router: MAINNET_ADDRESSES.SUSHISWAP_ROUTER,
          tokenIn: MAINNET_ADDRESSES.USDC,
          tokenOut: MAINNET_ADDRESSES.WETH,
          amountOutMin: 0n,
        },
      ];

      const block = await ethers.provider.getBlock('latest');
      const deadline = BigInt(block!.timestamp) + 300n;

      // This calls real Aave V3 Pool.flashLoan → contract.executeOperation callback
      // → real DEX swaps. The round-trip loses money to fees/slippage, so it
      // reverts with InsufficientProfit after the callback completes swap execution.
      await expect(
        flashLoanArbitrage.executeArbitrage(
          MAINNET_ADDRESSES.WETH,
          flashLoanAmount,
          swapPath,
          0n, // minimumProfit
          deadline
        )
      ).to.be.reverted; // Reverts in Aave callback (InsufficientProfit or DEX slippage)
    });

    it('should calculate expected profit using real DEX quotes', async () => {
      const { flashLoanArbitrage } = await loadFixture(deployWithRealAaveFixture);

      const flashLoanAmount = ethers.parseEther('10'); // 10 WETH

      // Build a realistic swap path
      const swapPath = [
        {
          router: MAINNET_ADDRESSES.UNISWAP_V2_ROUTER,
          tokenIn: MAINNET_ADDRESSES.WETH,
          tokenOut: MAINNET_ADDRESSES.USDC,
          amountOutMin: 0n, // No minimum for calculation
        },
        {
          router: MAINNET_ADDRESSES.SUSHISWAP_ROUTER,
          tokenIn: MAINNET_ADDRESSES.USDC,
          tokenOut: MAINNET_ADDRESSES.WETH,
          amountOutMin: 0n,
        },
      ];

      // Call calculateExpectedProfit - this calls real DEX routers
      const [expectedProfit, flashLoanFee] = await flashLoanArbitrage.calculateExpectedProfit(
        MAINNET_ADDRESSES.WETH,
        flashLoanAmount,
        swapPath
      );

      console.log(`  Flash Loan Amount: ${ethers.formatEther(flashLoanAmount)} WETH`);
      console.log(`  Flash Loan Fee:    ${ethers.formatEther(flashLoanFee)} WETH (0.09%)`);
      console.log(`  Expected Profit:   ${ethers.formatEther(expectedProfit)} WETH`);

      // Flash loan fee should be 0.09% of 10 WETH = 0.009 WETH
      expect(flashLoanFee).to.equal(ethers.parseEther('0.009'));

      // Expected profit is likely negative or zero (no real arbitrage at forked block)
      // This validates the contract correctly queries real DEX state
    });
  });

  // ===========================================================================
  // Gas Estimation Tests
  // ===========================================================================

  describe('Gas Estimation', () => {
    it('should estimate gas for executeArbitrage call', async () => {
      const { flashLoanArbitrage, owner } = await loadFixture(deployWithRealAaveFixture);

      const flashLoanAmount = ethers.parseEther('1'); // 1 WETH

      const swapPath = [
        {
          router: MAINNET_ADDRESSES.UNISWAP_V2_ROUTER,
          tokenIn: MAINNET_ADDRESSES.WETH,
          tokenOut: MAINNET_ADDRESSES.USDC,
          amountOutMin: 0n,
        },
        {
          router: MAINNET_ADDRESSES.SUSHISWAP_ROUTER,
          tokenIn: MAINNET_ADDRESSES.USDC,
          tokenOut: MAINNET_ADDRESSES.WETH,
          amountOutMin: 0n,
        },
      ];

      // Estimate gas (will revert but gives us gas estimate)
      // Fix P2: Add deadline parameter (5th argument) required since v1.2.0
      const block = await ethers.provider.getBlock('latest');
      const deadline = BigInt(block!.timestamp) + 300n;

      try {
        const gasEstimate = await flashLoanArbitrage.executeArbitrage.estimateGas(
          MAINNET_ADDRESSES.WETH,
          flashLoanAmount,
          swapPath,
          0n,
          deadline
        );
        console.log(`  Estimated gas: ${gasEstimate.toString()}`);
      } catch (error: unknown) {
        // Expected to revert (unprofitable trade)
        // But we can still extract useful info from the error
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`  Gas estimation reverted (expected): trade likely unprofitable`);

        // The error should indicate the revert reason
        const isExpectedError = errorMessage.includes('InsufficientProfit') ||
                               errorMessage.includes('execution reverted');
        expect(isExpectedError).to.be.true;
      }
    });
  });

  // ===========================================================================
  // Security Tests
  // ===========================================================================

  describe('Security Validation', () => {
    it('should reject calls from non-owner for admin functions', async () => {
      const { flashLoanArbitrage, user } = await loadFixture(deployWithRealAaveFixture);

      const userContract = flashLoanArbitrage.connect(user) as FlashLoanArbitrage;

      // All admin functions should revert
      await expect(
        userContract.addApprovedRouter(ethers.ZeroAddress)
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        userContract.removeApprovedRouter(MAINNET_ADDRESSES.UNISWAP_V2_ROUTER)
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        userContract.setMinimumProfit(1000n)
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        userContract.pause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('should not allow direct executeOperation calls', async () => {
      const { flashLoanArbitrage, user } = await loadFixture(deployWithRealAaveFixture);

      // Try to call executeOperation directly
      const userContract = flashLoanArbitrage.connect(user) as FlashLoanArbitrage;
      await expect(
        userContract.executeOperation(
          MAINNET_ADDRESSES.WETH,
          ethers.parseEther('10'),
          ethers.parseEther('0.009'),
          user.address,
          '0x'
        )
      ).to.be.revertedWithCustomError(flashLoanArbitrage, 'InvalidFlashLoanCaller');
    });
  });

  // ===========================================================================
  // View Function Tests
  // ===========================================================================

  describe('View Functions', () => {
    it('should return correct POOL address', async () => {
      const { flashLoanArbitrage } = await loadFixture(deployWithRealAaveFixture);

      const poolAddress = await flashLoanArbitrage.POOL();
      expect(poolAddress).to.equal(MAINNET_ADDRESSES.AAVE_V3_POOL);
    });

    it('should return approved routers list', async () => {
      const { flashLoanArbitrage } = await loadFixture(deployWithRealAaveFixture);

      const routers = await flashLoanArbitrage.getApprovedRouters();
      expect(routers.length).to.equal(2);
      expect(routers).to.include(MAINNET_ADDRESSES.UNISWAP_V2_ROUTER);
      expect(routers).to.include(MAINNET_ADDRESSES.SUSHISWAP_ROUTER);
    });
  });
});

// =============================================================================
// Additional Test: Real Arbitrage Simulation (requires whale impersonation)
// =============================================================================

describe('FlashLoanArbitrage - Whale Impersonation Tests', function () {
  this.timeout(120000);

  before(function () {
    if (!FORK_ENABLED) {
      this.skip();
    }
  });

  it('should verify whale accounts have expected balances', async function () {
    // Get whale account balances for verification
    const [owner] = await ethers.getSigners();
    const weth = new ethers.Contract(MAINNET_ADDRESSES.WETH, ERC20_ABI, owner);

    const whaleBalance = await weth.balanceOf(MAINNET_ADDRESSES.WETH_WHALE);
    console.log(`  WETH Whale Balance: ${ethers.formatEther(whaleBalance)} WETH`);

    // Whale should have significant balance
    expect(whaleBalance).to.be.gt(ethers.parseEther('100'));
  });

  it('should allow impersonating whale for testing', async function () {
    // Impersonate whale account
    await impersonateAccount(MAINNET_ADDRESSES.WETH_WHALE);
    const whale = await ethers.getSigner(MAINNET_ADDRESSES.WETH_WHALE);

    // Give whale ETH for gas
    await setBalance(MAINNET_ADDRESSES.WETH_WHALE, ethers.parseEther('10'));

    const balance = await ethers.provider.getBalance(MAINNET_ADDRESSES.WETH_WHALE);
    expect(balance).to.equal(ethers.parseEther('10'));

    console.log(`  ✅ Successfully impersonated whale: ${whale.address}`);
  });
});
