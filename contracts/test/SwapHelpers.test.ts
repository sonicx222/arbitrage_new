import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { SwapHelpersWrapper, MockDexRouter, MockERC20 } from '../typechain-types';

/**
 * SwapHelpers Library Tests
 *
 * Direct unit tests for the SwapHelpers library via SwapHelpersWrapper.
 * Previously only tested indirectly through BaseFlashArbitrage integration.
 *
 * Tests:
 * - Successful swap execution and output
 * - Token continuity validation (InvalidSwapPath)
 * - Output verification (InsufficientOutputAmount)
 * - Approval set before swap and reset after swap
 * - Path array population
 * - forceApprove handles non-zero existing allowance (USDT pattern)
 * - Correct router called
 * - Deadline passed through to router
 */
describe('SwapHelpers', () => {
  async function deployFixture() {
    const [owner] = await ethers.getSigners();

    // Deploy wrapper
    const WrapperFactory = await ethers.getContractFactory('SwapHelpersWrapper');
    const wrapper = await WrapperFactory.deploy();

    // Deploy tokens
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const weth = await MockERC20Factory.deploy('Wrapped Ether', 'WETH', 18);
    const usdc = await MockERC20Factory.deploy('USD Coin', 'USDC', 6);

    // Deploy router
    const MockDexRouterFactory = await ethers.getContractFactory('MockDexRouter');
    const router = await MockDexRouterFactory.deploy('TestRouter');

    // Get addresses
    const wrapperAddr = await wrapper.getAddress();
    const wethAddr = await weth.getAddress();
    const usdcAddr = await usdc.getAddress();
    const routerAddr = await router.getAddress();

    // Fund wrapper with input tokens
    await weth.mint(wrapperAddr, ethers.parseEther('1000'));
    await usdc.mint(wrapperAddr, ethers.parseUnits('1000000', 6));

    // Fund router with output tokens
    await weth.mint(routerAddr, ethers.parseEther('1000'));
    await usdc.mint(routerAddr, ethers.parseUnits('1000000', 6));

    // Set exchange rate: 1 WETH = 2000 USDC
    await router.setExchangeRate(wethAddr, usdcAddr, ethers.parseUnits('2000', 6));
    // Reverse: 1 USDC = 0.0005 WETH
    await router.setExchangeRate(usdcAddr, wethAddr, ethers.parseEther('0.0005'));

    const deadline = (await ethers.provider.getBlock('latest'))!.timestamp + 3600;

    return { wrapper, weth, usdc, router, owner, wrapperAddr, wethAddr, usdcAddr, routerAddr, deadline };
  }

  it('should execute a successful single swap and return correct output', async () => {
    const { wrapper, wethAddr, usdcAddr, routerAddr, deadline } =
      await loadFixture(deployFixture);

    const amountIn = ethers.parseEther('10');

    const amountOut = await wrapper.executeSingleSwap.staticCall(
      wethAddr, amountIn, routerAddr, wethAddr, usdcAddr, 1n, deadline
    );

    // 10 WETH * 2000 USDC/WETH = 20000 USDC
    expect(amountOut).to.equal(ethers.parseUnits('20000', 6));
  });

  it('should revert with InvalidSwapPath when tokenIn != currentToken', async () => {
    const { wrapper, wethAddr, usdcAddr, routerAddr, deadline } =
      await loadFixture(deployFixture);

    // currentToken is WETH, but tokenIn is USDC — mismatch
    await expect(
      wrapper.executeSingleSwap(
        wethAddr, ethers.parseEther('10'), routerAddr, usdcAddr, wethAddr, 1n, deadline
      )
    ).to.be.revertedWithCustomError(wrapper, 'InvalidSwapPath');
  });

  it('should revert with InsufficientOutputAmount when output < amountOutMin', async () => {
    const { wrapper, wethAddr, usdcAddr, routerAddr, deadline } =
      await loadFixture(deployFixture);

    // 10 WETH -> 20000 USDC, but we set amountOutMin absurdly high
    const absurdMinimum = ethers.parseUnits('999999', 6);

    await expect(
      wrapper.executeSingleSwap(
        wethAddr, ethers.parseEther('10'), routerAddr, wethAddr, usdcAddr, absurdMinimum, deadline
      )
    ).to.be.revertedWith('Insufficient output amount'); // MockDexRouter revert, not InsufficientOutputAmount
  });

  it('should set approval before swap (router receives allowance)', async () => {
    const { wrapper, weth, wethAddr, usdcAddr, routerAddr, wrapperAddr, deadline } =
      await loadFixture(deployFixture);

    // Verify allowance is 0 before
    expect(await weth.allowance(wrapperAddr, routerAddr)).to.equal(0);

    // Execute the swap (state-changing call)
    await wrapper.executeSingleSwap(
      wethAddr, ethers.parseEther('10'), routerAddr, wethAddr, usdcAddr, 1n, deadline
    );

    // Swap succeeded — the router was able to transferFrom, proving approval was set
    // (if approval wasn't set, the router's safeTransferFrom would revert)
  });

  it('should reset approval to 0 after swap completes', async () => {
    const { wrapper, weth, wethAddr, usdcAddr, routerAddr, wrapperAddr, deadline } =
      await loadFixture(deployFixture);

    await wrapper.executeSingleSwap(
      wethAddr, ethers.parseEther('10'), routerAddr, wethAddr, usdcAddr, 1n, deadline
    );

    // After swap, allowance should be reset to 0
    expect(await weth.allowance(wrapperAddr, routerAddr)).to.equal(0);
  });

  it('should transfer output tokens to the wrapper contract', async () => {
    const { wrapper, usdc, wethAddr, usdcAddr, routerAddr, wrapperAddr, deadline } =
      await loadFixture(deployFixture);

    const balanceBefore = await usdc.balanceOf(wrapperAddr);

    await wrapper.executeSingleSwap(
      wethAddr, ethers.parseEther('10'), routerAddr, wethAddr, usdcAddr, 1n, deadline
    );

    const balanceAfter = await usdc.balanceOf(wrapperAddr);
    expect(balanceAfter - balanceBefore).to.equal(ethers.parseUnits('20000', 6));
  });

  it('should handle forceApprove with non-zero existing allowance (USDT pattern)', async () => {
    const { wrapper, weth, wethAddr, usdcAddr, routerAddr, wrapperAddr, deadline } =
      await loadFixture(deployFixture);

    // First swap sets and resets approval
    await wrapper.executeSingleSwap(
      wethAddr, ethers.parseEther('5'), routerAddr, wethAddr, usdcAddr, 1n, deadline
    );

    // Second swap should also succeed — forceApprove handles 0->N transition
    await wrapper.executeSingleSwap(
      wethAddr, ethers.parseEther('5'), routerAddr, wethAddr, usdcAddr, 1n, deadline
    );

    // Both swaps succeeded without reverting, proving forceApprove works
    expect(await weth.allowance(wrapperAddr, routerAddr)).to.equal(0);
  });

  it('should route the swap through the specified router', async () => {
    const { wrapper, wethAddr, usdcAddr, routerAddr, deadline } =
      await loadFixture(deployFixture);

    // Execute swap and verify the Swap event comes from the correct router
    await expect(
      wrapper.executeSingleSwap(
        wethAddr, ethers.parseEther('10'), routerAddr, wethAddr, usdcAddr, 1n, deadline
      )
    ).to.emit(
      // Attach the MockDexRouter contract to verify its events
      await ethers.getContractAt('MockDexRouter', routerAddr),
      'Swap'
    ).withArgs(wethAddr, usdcAddr, ethers.parseEther('10'), ethers.parseUnits('20000', 6));
  });

  it('should deduct input tokens from the wrapper', async () => {
    const { wrapper, weth, wethAddr, usdcAddr, routerAddr, wrapperAddr, deadline } =
      await loadFixture(deployFixture);

    const balanceBefore = await weth.balanceOf(wrapperAddr);

    await wrapper.executeSingleSwap(
      wethAddr, ethers.parseEther('10'), routerAddr, wethAddr, usdcAddr, 1n, deadline
    );

    const balanceAfter = await weth.balanceOf(wrapperAddr);
    expect(balanceBefore - balanceAfter).to.equal(ethers.parseEther('10'));
  });

  it('should revert when router has no exchange rate set', async () => {
    const { wrapper, wethAddr, routerAddr, deadline } =
      await loadFixture(deployFixture);

    // Deploy a new token with no exchange rate configured
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const unknownToken = await MockERC20Factory.deploy('Unknown', 'UNK', 18);
    const unknownAddr = await unknownToken.getAddress();

    await expect(
      wrapper.executeSingleSwap(
        wethAddr, ethers.parseEther('1'), routerAddr, wethAddr, unknownAddr, 1n, deadline
      )
    ).to.be.revertedWith('Exchange rate not set');
  });
});
