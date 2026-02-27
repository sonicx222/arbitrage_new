/**
 * Shared Base Test Helpers for Flash Arbitrage Contracts
 *
 * Provides reusable test suites for behaviors inherited from BaseFlashArbitrage
 * that are NOT admin-only functions (those live in shared-admin-tests.ts):
 * - Deployment defaults (owner, minimumProfit, swapDeadline, constants, initial state)
 * - Input validation (_validateArbitrageParams: amount, deadline, path, router, slippage)
 * - Profit validation (_verifyAndTrackProfit: minProfit, minimumProfit)
 * - Reentrancy protection (MockMaliciousRouter attack prevention)
 *
 * Usage:
 *   import { testDeploymentDefaults, testInputValidation, ... } from './helpers';
 *
 *   testDeploymentDefaults({
 *     contractName: 'SyncSwapFlashArbitrage',
 *     getFixture: async () => {
 *       const f = await loadFixture(deployContractsFixture);
 *       return { contract: f.syncSwapArbitrage, owner: f.owner };
 *     },
 *   });
 *
 * @see contracts/src/base/BaseFlashArbitrage.sol
 * @see shared-admin-tests.ts for admin function tests
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';

// =============================================================================
// Types
// =============================================================================

export interface DeploymentTestFixture {
  /** The contract under test (any contract extending BaseFlashArbitrage) */
  contract: any;
  /** Owner signer (deployer) */
  owner: any;
}

export interface DeploymentTestConfig {
  /** Contract name for describe blocks */
  contractName: string;
  /** Returns a fresh fixture with normalized field names */
  getFixture: () => Promise<DeploymentTestFixture>;
}

export interface ValidationTestFixture {
  /** The contract under test */
  contract: any;
  /** Owner signer */
  owner: any;
  /** Non-owner signer */
  user: any;
  /** First mock DEX router */
  dexRouter1: any;
  /** Second mock DEX router (for cross-router tests) */
  dexRouter2: any;
  /** WETH mock token */
  weth: any;
  /** USDC mock token */
  usdc: any;
  /** DAI mock token (for 3-hop tests) */
  dai: any;
}

export interface ValidationTestConfig {
  /** Contract name for describe blocks */
  contractName: string;
  /** Returns a fresh fixture with normalized field names */
  getFixture: () => Promise<ValidationTestFixture>;
  /**
   * Callback that triggers the contract's arbitrage entry function.
   * Must translate the normalized params into the contract's specific signature.
   *
   * @param contract - The contract instance
   * @param signer - The signer to call with (.connect already applied by caller)
   * @param params - Normalized parameters
   * @returns The transaction promise (NOT awaited — caller needs the promise for expect())
   */
  triggerArbitrage: (
    contract: any,
    signer: any,
    params: {
      asset: string;
      amount: bigint;
      swapPath: Array<{
        router: string;
        tokenIn: string;
        tokenOut: string;
        amountOutMin: bigint;
      }>;
      minProfit: bigint;
      deadline: number;
    }
  ) => Promise<any>;
  /**
   * Returns the asset address to use in tests.
   * Defaults to weth if not provided.
   */
  getAssetAddress?: (fixture: ValidationTestFixture) => Promise<string>;
}

export interface ProfitValidationTestConfig extends ValidationTestConfig {
  /**
   * Sets up exchange rates to produce a small profit (~1% on 1 WETH).
   * Must configure dexRouter1 so that asset→usdc→asset yields slightly more than input.
   */
  setupSmallProfitRates: (fixture: ValidationTestFixture) => Promise<void>;
}

export interface ReentrancyTestFixture extends ValidationTestFixture {
  /** Any extra data needed for reentrancy trigger (e.g., pool address for PancakeSwap) */
  [key: string]: any;
}

export interface ReentrancyTestConfig {
  /** Contract name for describe blocks */
  contractName: string;
  /** Returns a fresh fixture with normalized field names */
  getFixture: () => Promise<ReentrancyTestFixture>;
  /**
   * Triggers an arbitrage through the malicious router.
   * Must set up rates, fund the malicious router, build the swap path, and execute.
   *
   * @param fixture - The full fixture
   * @param maliciousRouterAddress - The deployed malicious router address
   * @returns The transaction promise
   */
  triggerWithMaliciousRouter: (
    fixture: ReentrancyTestFixture,
    maliciousRouterAddress: string
  ) => Promise<any>;
}

// =============================================================================
// Helper: getDeadline
// =============================================================================

async function getDeadline(offsetSeconds = 3600): Promise<number> {
  const block = await ethers.provider.getBlock('latest');
  return block!.timestamp + offsetSeconds;
}

// =============================================================================
// SB-1: Deployment Defaults (~7 tests)
// =============================================================================

/**
 * Tests deployment defaults inherited from BaseFlashArbitrage.
 * Verifies: owner, totalProfits, minimumProfit, swapDeadline, constants, router list, paused state.
 *
 * Protocol-specific deployment tests (POOL, VAULT, FACTORY, DSS_FLASH, constructor rejections)
 * should remain in individual test files.
 */
export function testDeploymentDefaults(config: DeploymentTestConfig): void {
  const { contractName, getFixture } = config;

  describe(`${contractName} — Base Deployment Defaults`, () => {
    it('should deploy with correct owner', async () => {
      const { contract, owner } = await getFixture();
      expect(await contract.owner()).to.equal(owner.address);
    });

    it('should initialize totalProfits to zero', async () => {
      const { contract } = await getFixture();
      expect(await contract.totalProfits()).to.equal(0);
    });

    it('should initialize minimumProfit to default (1e14)', async () => {
      const { contract } = await getFixture();
      expect(await contract.minimumProfit()).to.equal(BigInt(1e14));
    });

    it('should initialize swapDeadline to default (60 seconds)', async () => {
      const { contract } = await getFixture();
      expect(await contract.swapDeadline()).to.equal(60);
    });

    it('should have correct BaseFlashArbitrage constants', async () => {
      const { contract } = await getFixture();
      expect(await contract.DEFAULT_SWAP_DEADLINE()).to.equal(60n);
      expect(await contract.MAX_SWAP_DEADLINE()).to.equal(600n);
      expect(await contract.MIN_SLIPPAGE_BPS()).to.equal(10n);
      expect(await contract.MAX_SWAP_HOPS()).to.equal(5n);
    });

    it('should initialize with empty approved router list', async () => {
      const { contract } = await getFixture();
      const routers = await contract.getApprovedRouters();
      expect(routers.length).to.equal(0);
    });

    it('should start in unpaused state', async () => {
      const { contract } = await getFixture();
      expect(await contract.paused()).to.be.false;
    });
  });
}

// =============================================================================
// SB-2: Input Validation (~10 tests)
// =============================================================================

/**
 * Tests _validateArbitrageParams input validation from BaseFlashArbitrage.
 * Verifies: InvalidAmount, TransactionTooOld, EmptySwapPath, PathTooLong,
 * SwapPathAssetMismatch, RouterNotApproved, InsufficientSlippageProtection,
 * Pausable, InvalidSwapPath (token continuity), InvalidSwapPath (cycle completeness).
 *
 * Each test file provides a `triggerArbitrage` callback that translates normalized
 * params into the contract's specific function signature.
 */
export function testInputValidation(config: ValidationTestConfig): void {
  const { contractName, getFixture, triggerArbitrage } = config;
  const getAsset = config.getAssetAddress ?? (async (f: ValidationTestFixture) => f.weth.getAddress());

  describe(`${contractName} — Input Validation (_validateArbitrageParams)`, () => {
    it('should revert on zero amount', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1 } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];
      const deadline = await getDeadline();

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: 0n,
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'InvalidAmount');
    });

    it('should revert on expired deadline', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1 } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];
      const staleDeadline = (await ethers.provider.getBlock('latest'))!.timestamp - 1;

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline: staleDeadline,
        })
      ).to.be.revertedWithCustomError(contract, 'TransactionTooOld');
    });

    it('should revert on empty swap path', async () => {
      const fixture = await getFixture();
      const { contract, owner } = fixture;
      const assetAddress = await getAsset(fixture);
      const deadline = await getDeadline();

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath: [],
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'EmptySwapPath');
    });

    it('should revert on path too long (> MAX_SWAP_HOPS)', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1 } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      const routerAddr = await dexRouter1.getAddress();
      const deadline = await getDeadline();

      // 6 hops exceeds MAX_SWAP_HOPS (5)
      const swapPath = Array(6).fill({
        router: routerAddr,
        tokenIn: assetAddress,
        tokenOut: assetAddress,
        amountOutMin: 1n,
      });

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'PathTooLong');
    });

    it('should revert on asset mismatch (first hop tokenIn != asset)', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, usdc } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      const deadline = await getDeadline();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(), // Wrong — should be asset
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'SwapPathAssetMismatch');
    });

    it('should revert on unapproved router in path', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1 } = fixture;
      const assetAddress = await getAsset(fixture);
      const deadline = await getDeadline();

      // Don't approve dexRouter1
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'RouterNotApproved');
    });

    it('should revert on zero amountOutMin (no slippage protection)', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1 } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      const deadline = await getDeadline();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: assetAddress,
          amountOutMin: 0n, // No slippage protection
        },
      ];

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'InsufficientSlippageProtection');
    });

    it('should revert when contract is paused', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1 } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await contract.connect(owner).pause();
      const deadline = await getDeadline();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWith('Pausable: paused');
    });

    it('should revert on token continuity error (step[i].tokenIn != step[i-1].tokenOut)', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, usdc, dai } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      const deadline = await getDeadline();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await dai.getAddress(), // Wrong — should be USDC
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'InvalidSwapPath');
    });

    it('should revert on incomplete cycle (last tokenOut != asset)', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, usdc } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      const deadline = await getDeadline();

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: await usdc.getAddress(), // Ends with USDC, not asset
          amountOutMin: 1n,
        },
      ];

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'InvalidSwapPath');
    });
  });
}

// =============================================================================
// SB-4: Profit Validation (~3 tests)
// =============================================================================

/**
 * Tests _verifyAndTrackProfit profit validation from BaseFlashArbitrage.
 * Verifies: InsufficientProfit below minProfit param, below minimumProfit setting,
 * and max-of-both enforcement.
 *
 * Requires `setupSmallProfitRates` to configure exchange rates that produce ~1% profit.
 */
export function testProfitValidation(config: ProfitValidationTestConfig): void {
  const { contractName, getFixture, triggerArbitrage, setupSmallProfitRates } = config;
  const getAsset = config.getAssetAddress ?? (async (f: ValidationTestFixture) => f.weth.getAddress());

  describe(`${contractName} — Profit Validation (_verifyAndTrackProfit)`, () => {
    it('should revert if profit < minProfit parameter', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, usdc } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await setupSmallProfitRates(fixture);

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];
      const deadline = await getDeadline();

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: ethers.parseEther('10'), // Absurdly high — will fail
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'InsufficientProfit');
    });

    it('should revert if profit < contract minimumProfit', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, usdc } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      await contract.connect(owner).setMinimumProfit(ethers.parseEther('10')); // High threshold
      await setupSmallProfitRates(fixture);

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];
      const deadline = await getDeadline();

      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: 0n,
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'InsufficientProfit');
    });

    it('should enforce max of minProfit param and contract minimumProfit', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, usdc } = fixture;
      const assetAddress = await getAsset(fixture);

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());
      // Set low global minimum — the param minimum should still apply
      await contract.connect(owner).setMinimumProfit(1n);
      await setupSmallProfitRates(fixture);

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: assetAddress,
          tokenOut: await usdc.getAddress(),
          amountOutMin: 1n,
        },
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(),
          tokenOut: assetAddress,
          amountOutMin: 1n,
        },
      ];
      const deadline = await getDeadline();

      // minProfit param is absurdly high, overrides low global minimum
      await expect(
        triggerArbitrage(contract, owner, {
          asset: assetAddress,
          amount: ethers.parseEther('1'),
          swapPath,
          minProfit: ethers.parseEther('10'),
          deadline,
        })
      ).to.be.revertedWithCustomError(contract, 'InsufficientProfit');
    });
  });
}

// =============================================================================
// SB-3: calculateExpectedProfit (~5 tests)
// =============================================================================

export interface CalculateProfitTestFixture {
  /** The contract under test */
  contract: any;
  /** Owner signer */
  owner: any;
  /** First mock DEX router */
  dexRouter1: any;
  /** WETH mock token */
  weth: any;
  /** USDC mock token */
  usdc: any;
}

export interface CalculateProfitResult {
  /** Expected profit (0 if unprofitable/invalid) */
  expectedProfit: bigint;
  /** Flash loan fee (undefined for CommitReveal which returns single value) */
  flashLoanFee?: bigint;
}

export interface CalculateProfitTestConfig {
  /** Contract name for describe blocks */
  contractName: string;
  /** Returns a fresh fixture with normalized field names */
  getFixture: () => Promise<CalculateProfitTestFixture>;
  /**
   * Callback that triggers calculateExpectedProfit with the contract's specific signature.
   * Must return a normalized result with expectedProfit (and optionally flashLoanFee).
   *
   * @param contract - The contract instance
   * @param params - Normalized parameters: asset address, amount, swap path
   * @returns Normalized result
   */
  triggerCalculateProfit: (
    contract: any,
    params: {
      asset: string;
      amount: bigint;
      swapPath: Array<{
        router: string;
        tokenIn: string;
        tokenOut: string;
        amountOutMin: bigint;
      }>;
    }
  ) => Promise<CalculateProfitResult>;
  /**
   * Rate constant for USDC -> WETH that produces a profitable round trip.
   * Different contracts have different fee structures, so the profitable rate varies.
   */
  profitableReverseRate: bigint;
}

/**
 * Tests calculateExpectedProfit view function common across all flash arbitrage contracts.
 * Verifies: profitable path, empty path, unprofitable path, wrong start asset, wrong end asset.
 *
 * Protocol-specific tests (Balancer cycle detection, fee-specific calculations) should
 * remain in individual test files.
 */
export function testCalculateExpectedProfit(config: CalculateProfitTestConfig): void {
  const { contractName, getFixture, triggerCalculateProfit, profitableReverseRate } = config;

  describe(`${contractName} — calculateExpectedProfit (shared)`, () => {
    it('should return positive profit for profitable path', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, weth, usdc } = fixture;

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );
      await dexRouter1.setExchangeRate(
        await usdc.getAddress(),
        await weth.getAddress(),
        profitableReverseRate
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

      const result = await triggerCalculateProfit(contract, {
        asset: await weth.getAddress(),
        amount: ethers.parseEther('10'),
        swapPath,
      });

      expect(result.expectedProfit).to.be.gt(0);
    });

    it('should return 0 profit for empty swap path', async () => {
      const fixture = await getFixture();
      const { contract, weth } = fixture;

      const result = await triggerCalculateProfit(contract, {
        asset: await weth.getAddress(),
        amount: ethers.parseEther('1'),
        swapPath: [],
      });

      expect(result.expectedProfit).to.equal(0);
    });

    it('should return 0 profit for unprofitable path', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, weth, usdc } = fixture;

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

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

      const result = await triggerCalculateProfit(contract, {
        asset: await weth.getAddress(),
        amount: ethers.parseEther('10'),
        swapPath,
      });

      expect(result.expectedProfit).to.equal(0);
    });

    it('should return 0 profit for path starting with wrong asset', async () => {
      const fixture = await getFixture();
      const { contract, dexRouter1, weth, usdc } = fixture;

      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await usdc.getAddress(), // Wrong — should be WETH
          tokenOut: await weth.getAddress(),
          amountOutMin: 0n,
        },
      ];

      const result = await triggerCalculateProfit(contract, {
        asset: await weth.getAddress(),
        amount: ethers.parseEther('1'),
        swapPath,
      });

      expect(result.expectedProfit).to.equal(0);
    });

    it('should return 0 profit for non-circular path (wrong end asset)', async () => {
      const fixture = await getFixture();
      const { contract, owner, dexRouter1, weth, usdc } = fixture;

      await contract.connect(owner).addApprovedRouter(await dexRouter1.getAddress());

      await dexRouter1.setExchangeRate(
        await weth.getAddress(),
        await usdc.getAddress(),
        ethers.parseUnits('2000', 6)
      );

      // Path ends with USDC, not WETH
      const swapPath = [
        {
          router: await dexRouter1.getAddress(),
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountOutMin: 0n,
        },
      ];

      const result = await triggerCalculateProfit(contract, {
        asset: await weth.getAddress(),
        amount: ethers.parseEther('10'),
        swapPath,
      });

      expect(result.expectedProfit).to.equal(0);
    });
  });
}

// =============================================================================
// SB-5: Reentrancy Protection (~1 test)
// =============================================================================

/**
 * Tests reentrancy protection via MockMaliciousRouter.
 * Deploys a malicious router, triggers an arbitrage through it, and verifies
 * the attack was attempted but blocked by ReentrancyGuard.
 */
export function testReentrancyProtection(config: ReentrancyTestConfig): void {
  const { contractName, getFixture, triggerWithMaliciousRouter } = config;

  describe(`${contractName} — Reentrancy Protection`, () => {
    it('should prevent reentrancy attacks via malicious router', async () => {
      const fixture = await getFixture();
      const { contract, owner, weth, usdc } = fixture;

      // Deploy malicious router targeting this contract
      const MaliciousRouterFactory = await ethers.getContractFactory('MockMaliciousRouter');
      const maliciousRouter = await MaliciousRouterFactory.deploy(
        await contract.getAddress()
      );
      const maliciousRouterAddress = await maliciousRouter.getAddress();

      await contract.connect(owner).addApprovedRouter(maliciousRouterAddress);

      // Fund the malicious router
      await weth.mint(maliciousRouterAddress, ethers.parseEther('100'));
      await usdc.mint(maliciousRouterAddress, ethers.parseEther('100'));

      await triggerWithMaliciousRouter(fixture, maliciousRouterAddress);

      // Verify the attack was attempted and blocked
      expect(await maliciousRouter.attackAttempted()).to.be.true;
      expect(await maliciousRouter.attackSucceeded()).to.be.false;
    });
  });
}
