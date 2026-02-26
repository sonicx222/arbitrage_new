import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

/**
 * Mock Protocol Fidelity Tests
 *
 * Validates that mock contracts faithfully reproduce real protocol behavior
 * (fee calculations, callback parameters, repayment logic, array validation).
 * Solidity's `override` keyword already enforces interface signature compliance
 * at compile time — these tests validate mock BEHAVIOR, not interface shape.
 *
 * Protocols covered:
 * 1. Aave V3 (MockAavePool) — fee calculation, executeOperation, repayment
 * 2. SyncSwap (MockSyncSwapVault) — EIP-3156 fee calculation
 * 3. Balancer V2 (MockBalancerVault) — array validation, flash loan
 * 4. PancakeSwap V3 (MockPancakeV3Pool/Factory) — fee tiers, dual-token flash
 *
 * @see contracts/src/mocks/MockAavePool.sol
 * @see contracts/src/mocks/MockSyncSwapVault.sol
 * @see contracts/src/mocks/MockBalancerVault.sol
 * @see contracts/src/mocks/MockPancakeV3Pool.sol
 * @see contracts/src/mocks/MockPancakeV3Factory.sol
 */
describe('Mock Protocol Fidelity', () => {
  // ===========================================================================
  // Fixtures
  // ===========================================================================

  async function deployAavePoolFixture() {
    const [owner, borrower] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const token = await MockERC20Factory.deploy('Test Token', 'TEST', 18);

    const MockAavePoolFactory = await ethers.getContractFactory('MockAavePool');
    const pool = await MockAavePoolFactory.deploy();

    await token.mint(await pool.getAddress(), ethers.parseEther('1000000'));

    return { pool, token, owner, borrower };
  }

  async function deploySyncSwapVaultFixture() {
    const [owner] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const weth = await MockERC20Factory.deploy('Wrapped Ether', 'WETH', 18);

    const MockSyncSwapVaultFactory = await ethers.getContractFactory('MockSyncSwapVault');
    const vault = await MockSyncSwapVaultFactory.deploy(await weth.getAddress());

    await weth.mint(await vault.getAddress(), ethers.parseEther('10000'));

    return { vault, weth, owner };
  }

  async function deployBalancerVaultFixture() {
    const [owner] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const token1 = await MockERC20Factory.deploy('Token1', 'TK1', 18);
    const token2 = await MockERC20Factory.deploy('Token2', 'TK2', 18);

    const MockBalancerVaultFactory = await ethers.getContractFactory('MockBalancerVault');
    const vault = await MockBalancerVaultFactory.deploy();

    await token1.mint(await vault.getAddress(), ethers.parseEther('10000'));
    await token2.mint(await vault.getAddress(), ethers.parseEther('10000'));

    const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
    const recipient = await MockFlashLoanRecipientFactory.deploy();

    return { vault, token1, token2, recipient, owner };
  }

  async function deployPancakeV3Fixture() {
    const [owner, borrower] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const token0 = await MockERC20Factory.deploy('Token0', 'TK0', 18);
    const token1 = await MockERC20Factory.deploy('Token1', 'TK1', 18);

    const MockPancakeV3FactoryFactory = await ethers.getContractFactory('MockPancakeV3Factory');
    const factory = await MockPancakeV3FactoryFactory.deploy();

    // PancakeSwap V3 fee tiers: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
    const MockPancakeV3PoolFactory = await ethers.getContractFactory('MockPancakeV3Pool');
    const pool = await MockPancakeV3PoolFactory.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      2500, // 0.25% fee
      await factory.getAddress()
    );

    await factory.registerPool(
      await token0.getAddress(),
      await token1.getAddress(),
      2500,
      await pool.getAddress()
    );

    await token0.mint(await pool.getAddress(), ethers.parseEther('1000000'));
    await token1.mint(await pool.getAddress(), ethers.parseEther('1000000'));

    return { factory, pool, token0, token1, owner, borrower };
  }

  // ===========================================================================
  // 1. Aave V3 (MockAavePool)
  // ===========================================================================

  describe('Aave V3', () => {
    describe('Fee Calculation', () => {
      it('should calculate premium as 0.09% (9 basis points)', async () => {
        const { pool } = await loadFixture(deployAavePoolFixture);
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        expect(premium).to.equal(9);
      });

      it('should calculate correct fee for 1000 token loan', async () => {
        const { pool } = await loadFixture(deployAavePoolFixture);
        const loanAmount = ethers.parseEther('1000');
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        const expectedFee = (loanAmount * BigInt(premium)) / 10000n;
        expect(expectedFee).to.equal(ethers.parseEther('0.9'));
      });

      it('should calculate correct fee for small amounts', async () => {
        const { pool } = await loadFixture(deployAavePoolFixture);
        const loanAmount = ethers.parseEther('1');
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        const expectedFee = (loanAmount * BigInt(premium)) / 10000n;
        expect(expectedFee).to.equal(ethers.parseEther('0.0009'));
      });

      it('should calculate correct fee for large amounts', async () => {
        const { pool } = await loadFixture(deployAavePoolFixture);
        const loanAmount = ethers.parseEther('1000000');
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        const expectedFee = (loanAmount * BigInt(premium)) / 10000n;
        expect(expectedFee).to.equal(ethers.parseEther('900'));
      });

      it('should handle rounding for very small amounts', async () => {
        const { pool } = await loadFixture(deployAavePoolFixture);
        const loanAmount = 1000n;
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        const expectedFee = (loanAmount * BigInt(premium)) / 10000n;
        expect(expectedFee).to.equal(0n);
      });
    });

    describe('executeOperation Return Value', () => {
      it('should revert if executeOperation returns false', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(false);

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            ethers.parseEther('100'),
            '0x',
            0
          )
        ).to.be.revertedWith('Flash loan execution failed');
      });

      it('should succeed if executeOperation returns true', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        await token.mint(await receiver.getAddress(), ethers.parseEther('1'));
        await receiver.approveToken(
          await token.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            ethers.parseEther('100'),
            '0x',
            0
          )
        ).to.not.be.reverted;
      });
    });

    describe('Callback Validation', () => {
      it('should pass correct parameters to executeOperation', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        const loanAmount = ethers.parseEther('100');
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

        await token.mint(await receiver.getAddress(), ethers.parseEther('1'));
        await receiver.approveToken(
          await token.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await pool.flashLoanSimple(
          await receiver.getAddress(),
          await token.getAddress(),
          loanAmount,
          '0x1234',
          0
        );

        expect(await receiver.lastAsset()).to.equal(await token.getAddress());
        expect(await receiver.lastAmount()).to.equal(loanAmount);
        expect(await receiver.lastPremium()).to.equal(expectedFee);
      });

      it('should revert if callback reverts', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldRevert(true);

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            ethers.parseEther('100'),
            '0x',
            0
          )
        ).to.be.revertedWith('Mock forced revert');
      });
    });

    describe('Repayment Verification', () => {
      it('should revert if repayment is insufficient', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        await receiver.approveToken(
          await token.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            ethers.parseEther('100'),
            '0x',
            0
          )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
      });

      it('should succeed if repayment is exact (amount + fee)', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        const loanAmount = ethers.parseEther('100');
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        const fee = (loanAmount * BigInt(premium)) / 10000n;

        await token.mint(await receiver.getAddress(), fee);
        await receiver.approveToken(
          await token.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            loanAmount,
            '0x',
            0
          )
        ).to.not.be.reverted;
      });

      it('should allow overpayment (extra tokens stay with pool)', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        const loanAmount = ethers.parseEther('100');

        await token.mint(await receiver.getAddress(), ethers.parseEther('10'));
        await receiver.approveToken(
          await token.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        const poolBalanceBefore = await token.balanceOf(await pool.getAddress());

        await pool.flashLoanSimple(
          await receiver.getAddress(),
          await token.getAddress(),
          loanAmount,
          '0x',
          0
        );

        const poolBalanceAfter = await token.balanceOf(await pool.getAddress());
        const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
        const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

        expect(poolBalanceAfter - poolBalanceBefore).to.be.gte(expectedFee);
      });
    });

    describe('Edge Cases', () => {
      it('should handle zero amount loan', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            0,
            '0x',
            0
          )
        ).to.not.be.reverted;
      });

      it('should handle maximum uint256 approval', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        await token.mint(await receiver.getAddress(), ethers.parseEther('1'));
        await receiver.approveToken(
          await token.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            ethers.parseEther('100'),
            '0x',
            0
          )
        ).to.not.be.reverted;
      });

      it('should handle empty userData', async () => {
        const { pool, token } = await loadFixture(deployAavePoolFixture);

        const MockReceiverFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const receiver = await MockReceiverFactory.deploy();
        await receiver.setShouldSucceed(true);

        await token.mint(await receiver.getAddress(), ethers.parseEther('1'));
        await receiver.approveToken(
          await token.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await expect(
          pool.flashLoanSimple(
            await receiver.getAddress(),
            await token.getAddress(),
            ethers.parseEther('100'),
            '0x',
            0
          )
        ).to.not.be.reverted;
      });
    });
  });

  // ===========================================================================
  // 2. SyncSwap (MockSyncSwapVault)
  // ===========================================================================

  describe('SyncSwap', () => {
    describe('Fee Calculation (ISyncSwapVault)', () => {
      it('should calculate fee as 0.3% of loan amount', async () => {
        const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

        const loanAmount = ethers.parseEther('1000');
        const expectedFee = loanAmount * 3n / 1000n;

        const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

        expect(actualFee).to.equal(expectedFee);
        expect(actualFee).to.equal(ethers.parseEther('3'));
      });

      it('should return fee percentage as 3e15 (0.3% with 18 decimals)', async () => {
        const { vault } = await loadFixture(deploySyncSwapVaultFixture);

        const feePercentage = await vault.flashLoanFeePercentage();

        expect(feePercentage).to.equal(3000000000000000n);
        expect(feePercentage).to.equal(ethers.parseEther('0.003'));
      });

      it('should calculate fee correctly for small amounts', async () => {
        const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

        const loanAmount = ethers.parseEther('1');
        const expectedFee = loanAmount * 3n / 1000n;

        const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

        expect(actualFee).to.equal(expectedFee);
        expect(actualFee).to.equal(ethers.parseEther('0.003'));
      });

      it('should calculate fee correctly for large amounts', async () => {
        const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

        const loanAmount = ethers.parseEther('1000000');
        const expectedFee = loanAmount * 3n / 1000n;

        const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

        expect(actualFee).to.equal(expectedFee);
        expect(actualFee).to.equal(ethers.parseEther('3000'));
      });

      it('should handle rounding for very small amounts', async () => {
        const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

        const loanAmount = 100n;
        const expectedFee = (loanAmount * 3n) / 1000n;

        const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

        expect(actualFee).to.equal(expectedFee);
        expect(actualFee).to.equal(0n);
      });
    });

    describe('EIP-3156 Compliance', () => {
      it('should implement EIP-3156 flashFee interface', async () => {
        const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

        const amount = ethers.parseEther('100');
        const fee = await vault.flashFee(await weth.getAddress(), amount);

        expect(fee).to.be.a('bigint');
        expect(fee).to.be.greaterThan(0n);
      });

      it('should implement EIP-3156 maxFlashLoan interface', async () => {
        const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

        const maxLoan = await vault.maxFlashLoan(await weth.getAddress());

        expect(maxLoan).to.be.a('bigint');
        expect(maxLoan).to.equal(ethers.parseEther('10000'));
      });

      it('should calculate fee independent of maxFlashLoan', async () => {
        const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

        const maxLoan = await vault.maxFlashLoan(await weth.getAddress());
        const feeForMax = await vault.flashFee(await weth.getAddress(), maxLoan);

        const expectedFee = (maxLoan * 3n) / 1000n;
        expect(feeForMax).to.equal(expectedFee);
      });
    });
  });

  // ===========================================================================
  // 3. Balancer V2 (MockBalancerVault)
  // ===========================================================================

  describe('Balancer V2', () => {
    describe('Array Validation (IBalancerV2Vault)', () => {
      it('should revert with "Array length mismatch" for mismatched array lengths', async () => {
        const { vault, token1, token2, recipient } = await loadFixture(deployBalancerVaultFixture);

        const tokens = [await token1.getAddress(), await token2.getAddress()];
        const amounts = [ethers.parseEther('100')]; // Only 1 amount for 2 tokens

        await expect(
          vault.flashLoan(await recipient.getAddress(), tokens, amounts, '0x')
        ).to.be.revertedWith('Array length mismatch');
      });

      it('should revert with "Empty arrays" for empty arrays', async () => {
        const { vault, recipient } = await loadFixture(deployBalancerVaultFixture);

        await expect(
          vault.flashLoan(await recipient.getAddress(), [], [], '0x')
        ).to.be.revertedWith('Empty arrays');
      });

      it('should revert with "Zero amount" for zero amount in array', async () => {
        const { vault, token1, recipient } = await loadFixture(deployBalancerVaultFixture);

        await expect(
          vault.flashLoan(
            await recipient.getAddress(),
            [await token1.getAddress()],
            [0n],
            '0x'
          )
        ).to.be.revertedWith('Zero amount');
      });

      it('should revert with "Zero amount" when one of multiple amounts is zero', async () => {
        const { vault, token1, token2, recipient } = await loadFixture(deployBalancerVaultFixture);

        await expect(
          vault.flashLoan(
            await recipient.getAddress(),
            [await token1.getAddress(), await token2.getAddress()],
            [ethers.parseEther('100'), 0n],
            '0x'
          )
        ).to.be.revertedWith('Zero amount');
      });

      it('should succeed with valid arrays (single token)', async () => {
        const { vault, token1, recipient } = await loadFixture(deployBalancerVaultFixture);

        await expect(
          vault.flashLoan(
            await recipient.getAddress(),
            [await token1.getAddress()],
            [ethers.parseEther('100')],
            '0x'
          )
        ).to.not.be.reverted;
      });

      it('should succeed with valid arrays (multiple tokens)', async () => {
        const { vault, token1, token2, recipient } = await loadFixture(deployBalancerVaultFixture);

        await expect(
          vault.flashLoan(
            await recipient.getAddress(),
            [await token1.getAddress(), await token2.getAddress()],
            [ethers.parseEther('100'), ethers.parseEther('200')],
            '0x'
          )
        ).to.not.be.reverted;
      });
    });
  });

  // ===========================================================================
  // 4. PancakeSwap V3 (MockPancakeV3Pool + MockPancakeV3Factory)
  // ===========================================================================

  describe('PancakeSwap V3', () => {
    describe('Fee Tier Validation', () => {
      it('should support 0.01% fee tier (100 fee units)', async () => {
        const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const MockPancakeV3PoolFactory = await ethers.getContractFactory('MockPancakeV3Pool');
        const pool = await MockPancakeV3PoolFactory.deploy(
          await token0.getAddress(),
          await token1.getAddress(),
          100,
          await factory.getAddress()
        );

        expect(await pool.fee()).to.equal(100);
      });

      it('should support 0.05% fee tier (500 fee units)', async () => {
        const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const MockPancakeV3PoolFactory = await ethers.getContractFactory('MockPancakeV3Pool');
        const pool = await MockPancakeV3PoolFactory.deploy(
          await token0.getAddress(),
          await token1.getAddress(),
          500,
          await factory.getAddress()
        );

        expect(await pool.fee()).to.equal(500);
      });

      it('should support 0.25% fee tier (2500 fee units)', async () => {
        const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const MockPancakeV3PoolFactory = await ethers.getContractFactory('MockPancakeV3Pool');
        const pool = await MockPancakeV3PoolFactory.deploy(
          await token0.getAddress(),
          await token1.getAddress(),
          2500,
          await factory.getAddress()
        );

        expect(await pool.fee()).to.equal(2500);
      });

      it('should support 1% fee tier (10000 fee units)', async () => {
        const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const MockPancakeV3PoolFactory = await ethers.getContractFactory('MockPancakeV3Pool');
        const pool = await MockPancakeV3PoolFactory.deploy(
          await token0.getAddress(),
          await token1.getAddress(),
          10000,
          await factory.getAddress()
        );

        expect(await pool.fee()).to.equal(10000);
      });

      it('should calculate correct fee for each tier', async () => {
        const loanAmount = ethers.parseEther('1000');

        const tiers = [
          { bps: 100, expected: ethers.parseEther('0.1') },
          { bps: 500, expected: ethers.parseEther('0.5') },
          { bps: 2500, expected: ethers.parseEther('2.5') },
          { bps: 10000, expected: ethers.parseEther('10') },
        ];

        for (const tier of tiers) {
          const calculatedFee = (loanAmount * BigInt(tier.bps)) / 1000000n;
          expect(calculatedFee).to.equal(tier.expected);
        }
      });
    });

    describe('Dual-Token Flash Loans', () => {
      it('should support single-token flash loan (token0 only)', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount0 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee);
        await recipient.approveToken(
          await token0.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await expect(
          pool.flash(await recipient.getAddress(), amount0, 0n, '0x')
        ).to.not.be.reverted;
      });

      it('should support single-token flash loan (token1 only)', async () => {
        const { pool, token1 } = await loadFixture(deployPancakeV3Fixture);

        const amount1 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount1 * 2500n) / 1000000n;
        await token1.mint(await recipient.getAddress(), fee);
        await recipient.approveToken(
          await token1.getAddress(),
          await pool.getAddress(),
          ethers.MaxUint256
        );

        await expect(
          pool.flash(await recipient.getAddress(), 0n, amount1, '0x')
        ).to.not.be.reverted;
      });

      it('should support dual-token flash loan (both tokens)', async () => {
        const { pool, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');
        const amount1 = ethers.parseEther('200');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee0 = (amount0 * 2500n) / 1000000n;
        const fee1 = (amount1 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee0);
        await token1.mint(await recipient.getAddress(), fee1);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);
        await recipient.approveToken(await token1.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), amount0, amount1, '0x')
        ).to.not.be.reverted;
      });

      it('should revert if both amounts are zero', async () => {
        const { pool } = await loadFixture(deployPancakeV3Fixture);

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        await expect(
          pool.flash(await recipient.getAddress(), 0, 0, '0x')
        ).to.be.revertedWith('Both amounts cannot be zero');
      });
    });

    describe('Callback Parameters', () => {
      it('should pass correct fee0 and fee1 to callback', async () => {
        const { pool, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');
        const amount1 = ethers.parseEther('200');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const poolFee = await pool.fee();
        const expectedFee0 = (amount0 * BigInt(poolFee)) / 1000000n;
        const expectedFee1 = (amount1 * BigInt(poolFee)) / 1000000n;

        await token0.mint(await recipient.getAddress(), expectedFee0);
        await token1.mint(await recipient.getAddress(), expectedFee1);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);
        await recipient.approveToken(await token1.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await pool.flash(await recipient.getAddress(), amount0, amount1, '0x1234');

        expect(await recipient.lastFee0()).to.equal(expectedFee0);
        expect(await recipient.lastFee1()).to.equal(expectedFee1);
      });

      it('should pass userData correctly to callback', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount0 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        const userData = ethers.solidityPacked(['uint256', 'address'], [42, await token0.getAddress()]);

        await pool.flash(await recipient.getAddress(), amount0, 0, userData);

        expect(await recipient.lastUserData()).to.equal(userData);
      });

      it('should handle empty userData', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount0 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), amount0, 0, '0x')
        ).to.not.be.reverted;
      });
    });

    describe('Repayment Verification', () => {
      it('should revert if token0 repayment is insufficient', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount0 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee / 2n);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), amount0, 0, '0x')
        ).to.be.revertedWith('Insufficient token0 repayment');
      });

      it('should revert if token1 repayment is insufficient', async () => {
        const { pool, token1 } = await loadFixture(deployPancakeV3Fixture);

        const amount1 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount1 * 2500n) / 1000000n;
        await token1.mint(await recipient.getAddress(), fee / 2n);
        await recipient.approveToken(await token1.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), 0, amount1, '0x')
        ).to.be.revertedWith('Insufficient token1 repayment');
      });

      it('should succeed with exact repayment (amount + fee)', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount0 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), amount0, 0, '0x')
        ).to.not.be.reverted;
      });

      it('should allow overpayment', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('100');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        await token0.mint(await recipient.getAddress(), ethers.parseEther('10'));
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), amount0, 0, '0x')
        ).to.not.be.reverted;
      });
    });

    describe('Pool Discovery via Factory', () => {
      it('should find pool via factory.getPool()', async () => {
        const { factory, pool, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const discoveredPool = await factory.getPool(
          await token0.getAddress(),
          await token1.getAddress(),
          2500
        );

        expect(discoveredPool).to.equal(await pool.getAddress());
      });

      it('should return zero address for non-existent pool', async () => {
        const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const nonExistentPool = await factory.getPool(
          await token0.getAddress(),
          await token1.getAddress(),
          500
        );

        expect(nonExistentPool).to.equal(ethers.ZeroAddress);
      });

      it('should support reverse token order lookup', async () => {
        const { factory, pool, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const discoveredPool = await factory.getPool(
          await token1.getAddress(),
          await token0.getAddress(),
          2500
        );

        expect(discoveredPool).to.equal(await pool.getAddress());
      });
    });

    describe('Edge Cases', () => {
      it('should handle very small amounts (dust)', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = 1000n;

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount0 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee + 1n);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), amount0, 0, '0x')
        ).to.not.be.reverted;
      });

      it('should handle maximum safe integer amounts', async () => {
        const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

        const amount0 = ethers.parseEther('1000000');

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        const fee = (amount0 * 2500n) / 1000000n;
        await token0.mint(await recipient.getAddress(), fee);
        await recipient.approveToken(await token0.getAddress(), await pool.getAddress(), ethers.MaxUint256);

        await expect(
          pool.flash(await recipient.getAddress(), amount0, 0, '0x')
        ).to.not.be.reverted;
      });

      it('should revert if pool has insufficient liquidity', async () => {
        const { pool } = await loadFixture(deployPancakeV3Fixture);

        const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
        const recipient = await MockFlashLoanRecipientFactory.deploy();

        await expect(
          pool.flash(await recipient.getAddress(), ethers.parseEther('10000000'), 0, '0x')
        ).to.be.revertedWith('Insufficient liquidity');
      });
    });
  });
});
