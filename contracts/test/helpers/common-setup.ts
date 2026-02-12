/**
 * Shared Test Setup Helpers
 *
 * Extracts common deployment and funding patterns used across all
 * flash arbitrage test suites. Each test file deploys its own
 * protocol-specific contract but shares token, router, and funding setup.
 *
 * @see performance-refactor.md Refactoring #1: Extract Common Test Fixtures
 */
import { ethers } from 'hardhat';
import { MockDexRouter, MockERC20 } from '../../typechain-types';

// =============================================================================
// Token Deployment
// =============================================================================

export interface DeployedTokens {
  weth: MockERC20;
  usdc: MockERC20;
  dai: MockERC20;
}

/**
 * Deploy the standard 3 mock tokens used across all test suites.
 * - WETH: 18 decimals
 * - USDC: 6 decimals
 * - DAI: 18 decimals
 */
export async function deployTokens(): Promise<DeployedTokens> {
  const MockERC20Factory = await ethers.getContractFactory('MockERC20');
  const weth = await MockERC20Factory.deploy('Wrapped Ether', 'WETH', 18);
  const usdc = await MockERC20Factory.deploy('USD Coin', 'USDC', 6);
  const dai = await MockERC20Factory.deploy('Dai Stablecoin', 'DAI', 18);
  return { weth, usdc, dai };
}

// =============================================================================
// Router Deployment
// =============================================================================

export interface DeployedRouters {
  dexRouter1: MockDexRouter;
  dexRouter2: MockDexRouter;
}

/**
 * Deploy the standard 2 mock DEX routers used for arbitrage testing.
 */
export async function deployRouters(): Promise<DeployedRouters> {
  const MockDexRouterFactory = await ethers.getContractFactory('MockDexRouter');
  const dexRouter1 = await MockDexRouterFactory.deploy('Router1');
  const dexRouter2 = await MockDexRouterFactory.deploy('Router2');
  return { dexRouter1, dexRouter2 };
}

// =============================================================================
// Router Funding
// =============================================================================

export interface FundingAmounts {
  wethPerRouter?: bigint;
  usdcPerRouter?: bigint;
  daiPerRouter?: bigint;
}

/** Default funding: 1000 WETH, 1M USDC, 1M DAI per router */
const DEFAULT_FUNDING: Required<FundingAmounts> = {
  wethPerRouter: ethers.parseEther('1000'),
  usdcPerRouter: ethers.parseUnits('1000000', 6),
  daiPerRouter: ethers.parseEther('1000000'),
};

/**
 * Fund DEX routers with tokens for swap testing.
 *
 * Default amounts match FlashLoanArbitrage, SyncSwap, PancakeSwap,
 * and CommitReveal test suites. BalancerV2 uses 10x amounts.
 */
export async function fundRouters(
  tokens: DeployedTokens,
  routers: DeployedRouters,
  amounts?: FundingAmounts,
): Promise<void> {
  const { weth, usdc, dai } = tokens;
  const { dexRouter1, dexRouter2 } = routers;
  const funding = { ...DEFAULT_FUNDING, ...amounts };

  const r1Addr = await dexRouter1.getAddress();
  const r2Addr = await dexRouter2.getAddress();

  await Promise.all([
    weth.mint(r1Addr, funding.wethPerRouter),
    weth.mint(r2Addr, funding.wethPerRouter),
    usdc.mint(r1Addr, funding.usdcPerRouter),
    usdc.mint(r2Addr, funding.usdcPerRouter),
    dai.mint(r1Addr, funding.daiPerRouter),
    dai.mint(r2Addr, funding.daiPerRouter),
  ]);
}

/**
 * Fund a flash loan provider (Aave pool, Balancer vault, SyncSwap vault)
 * with tokens so it can issue loans.
 */
export async function fundProvider(
  tokens: DeployedTokens,
  providerAddress: string,
  amounts?: FundingAmounts,
): Promise<void> {
  const { weth, usdc, dai } = tokens;
  const funding = { ...DEFAULT_FUNDING, ...amounts };

  await Promise.all([
    weth.mint(providerAddress, funding.wethPerRouter),
    usdc.mint(providerAddress, funding.usdcPerRouter),
    dai.mint(providerAddress, funding.daiPerRouter),
  ]);
}

// =============================================================================
// Combined Base Fixture
// =============================================================================

export interface BaseFixture extends DeployedTokens, DeployedRouters {
  owner: Awaited<ReturnType<typeof ethers.getSigners>>[0];
  user: Awaited<ReturnType<typeof ethers.getSigners>>[0];
  attacker: Awaited<ReturnType<typeof ethers.getSigners>>[0];
}

/**
 * Deploy tokens, routers, fund routers, and return signers.
 * This is the base fixture that all protocol-specific fixtures extend.
 */
export async function deployBaseFixture(
  routerFunding?: FundingAmounts,
): Promise<BaseFixture> {
  const [owner, user, attacker] = await ethers.getSigners();
  const tokens = await deployTokens();
  const routers = await deployRouters();
  await fundRouters(tokens, routers, routerFunding);

  return {
    ...tokens,
    ...routers,
    owner,
    user,
    attacker,
  };
}
