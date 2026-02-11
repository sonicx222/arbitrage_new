import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { MockPancakeV3Pool, MockPancakeV3Factory, MockERC20 } from '../typechain-types';

/**
 * PancakeSwap V3 Interface Compliance Tests
 *
 * Verifies that IPancakeV3FlashCallback interface implementation matches documentation:
 * 1. Fee tier validation (100, 500, 2500, 10000 bps)
 * 2. Dual-token flash loan support
 * 3. Callback parameter passing
 * 4. Repayment verification
 * 5. Input validation (at least one amount > 0)
 *
 * @see contracts/src/interfaces/IPancakeV3FlashCallback.sol
 * @see contracts/INTERFACE_FIXES_APPLIED.md
 */
describe('PancakeSwap V3 Interface Compliance', () => {
  // ===========================================================================
  // Test Fixtures
  // ===========================================================================

  async function deployPancakeV3Fixture() {
    const [owner, borrower] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const token0 = await MockERC20Factory.deploy('Token0', 'TK0', 18);
    const token1 = await MockERC20Factory.deploy('Token1', 'TK1', 18);

    // Deploy MockPancakeV3Factory
    const MockPancakeV3FactoryFactory = await ethers.getContractFactory(
      'MockPancakeV3Factory'
    );
    const factory = await MockPancakeV3FactoryFactory.deploy();

    // Deploy MockPancakeV3Pool with 0.25% fee (2500 fee units)
    // PancakeSwap V3 fee tiers: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
    // Note: fee units are hundredths of a bip (1e-6), NOT basis points
    const MockPancakeV3PoolFactory = await ethers.getContractFactory(
      'MockPancakeV3Pool'
    );
    const pool = await MockPancakeV3PoolFactory.deploy(
      await token0.getAddress(),
      await token1.getAddress(),
      2500 // 0.25% fee (valid PancakeSwap V3 tier)
    );

    // Register pool in factory
    await factory.registerPool(
      await token0.getAddress(),
      await token1.getAddress(),
      2500,
      await pool.getAddress()
    );

    // Fund pool for flash loans
    await token0.mint(await pool.getAddress(), ethers.parseEther('1000000'));
    await token1.mint(await pool.getAddress(), ethers.parseEther('1000000'));

    return { factory, pool, token0, token1, owner, borrower };
  }

  // ===========================================================================
  // 1. Fee Tier Tests
  // ===========================================================================

  describe('1. Fee Tier Validation', () => {
    it('should support 0.01% fee tier (100 bps)', async () => {
      const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

      const MockPancakeV3PoolFactory = await ethers.getContractFactory(
        'MockPancakeV3Pool'
      );
      const pool = await MockPancakeV3PoolFactory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        100 // 0.01% fee
      );

      const fee = await pool.fee();
      expect(fee).to.equal(100);
    });

    it('should support 0.05% fee tier (500 bps)', async () => {
      const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

      const MockPancakeV3PoolFactory = await ethers.getContractFactory(
        'MockPancakeV3Pool'
      );
      const pool = await MockPancakeV3PoolFactory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        500 // 0.05% fee
      );

      const fee = await pool.fee();
      expect(fee).to.equal(500);
    });

    it('should support 0.25% fee tier (2500 bps)', async () => {
      const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

      const MockPancakeV3PoolFactory = await ethers.getContractFactory(
        'MockPancakeV3Pool'
      );
      const pool = await MockPancakeV3PoolFactory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        2500 // 0.25% fee
      );

      const fee = await pool.fee();
      expect(fee).to.equal(2500);
    });

    it('should support 1% fee tier (10000 bps)', async () => {
      const { factory, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

      const MockPancakeV3PoolFactory = await ethers.getContractFactory(
        'MockPancakeV3Pool'
      );
      const pool = await MockPancakeV3PoolFactory.deploy(
        await token0.getAddress(),
        await token1.getAddress(),
        10000 // 1% fee
      );

      const fee = await pool.fee();
      expect(fee).to.equal(10000);
    });

    it('should calculate correct fee for each tier', async () => {
      const loanAmount = ethers.parseEther('1000');

      const tiers = [
        { bps: 100, expected: ethers.parseEther('0.1') }, // 0.01%
        { bps: 500, expected: ethers.parseEther('0.5') }, // 0.05%
        { bps: 2500, expected: ethers.parseEther('2.5') }, // 0.25%
        { bps: 10000, expected: ethers.parseEther('10') }, // 1%
      ];

      for (const tier of tiers) {
        // Fee = (amount * bps) / 1000000
        const calculatedFee = (loanAmount * BigInt(tier.bps)) / 1000000n;
        expect(calculatedFee).to.equal(tier.expected);
      }
    });
  });

  // ===========================================================================
  // 2. Dual-Token Flash Loan Tests
  // ===========================================================================

  describe('2. Dual-Token Flash Loans', () => {
    it('should support single-token flash loan (token0 only)', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');
      const amount1 = 0n;

      // Deploy mock recipient
      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      // Fund recipient for repayment
      const fee = (amount0 * 2500n) / 1000000n;
      await token0.mint(await recipient.getAddress(), fee);
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, amount1, '0x')
      ).to.not.be.reverted;
    });

    it('should support single-token flash loan (token1 only)', async () => {
      const { pool, token1 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = 0n;
      const amount1 = ethers.parseEther('100');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee = (amount1 * 2500n) / 1000000n;
      await token1.mint(await recipient.getAddress(), fee);
      await recipient.approveToken(
        await token1.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, amount1, '0x')
      ).to.not.be.reverted;
    });

    it('should support dual-token flash loan (both tokens)', async () => {
      const { pool, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');
      const amount1 = ethers.parseEther('200');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee0 = (amount0 * 2500n) / 1000000n;
      const fee1 = (amount1 * 2500n) / 1000000n;
      await token0.mint(await recipient.getAddress(), fee0);
      await token1.mint(await recipient.getAddress(), fee1);
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );
      await recipient.approveToken(
        await token1.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, amount1, '0x')
      ).to.not.be.reverted;
    });

    it('should revert if both amounts are zero', async () => {
      const { pool } = await loadFixture(deployPancakeV3Fixture);

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      // Both amounts zero should revert
      await expect(
        pool.flash(await recipient.getAddress(), 0, 0, '0x')
      ).to.be.revertedWith('Both amounts cannot be zero');
    });
  });

  // ===========================================================================
  // 3. Callback Parameter Tests
  // ===========================================================================

  describe('3. Callback Parameters', () => {
    it('should pass correct fee0 and fee1 to callback', async () => {
      const { pool, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');
      const amount1 = ethers.parseEther('200');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const poolFee = await pool.fee();
      const expectedFee0 = (amount0 * BigInt(poolFee)) / 1000000n;
      const expectedFee1 = (amount1 * BigInt(poolFee)) / 1000000n;

      await token0.mint(await recipient.getAddress(), expectedFee0);
      await token1.mint(await recipient.getAddress(), expectedFee1);
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );
      await recipient.approveToken(
        await token1.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await pool.flash(await recipient.getAddress(), amount0, amount1, '0x1234');

      // MockFlashLoanRecipient should record callback parameters
      const lastFee0 = await recipient.lastFee0();
      const lastFee1 = await recipient.lastFee1();

      expect(lastFee0).to.equal(expectedFee0);
      expect(lastFee1).to.equal(expectedFee1);
    });

    it('should pass userData correctly to callback', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee = (amount0 * 2500n) / 1000000n;
      await token0.mint(await recipient.getAddress(), fee);
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      const userData = ethers.solidityPacked(['uint256', 'address'], [42, await token0.getAddress()]);

      await pool.flash(await recipient.getAddress(), amount0, 0, userData);

      const lastData = await recipient.lastUserData();
      expect(lastData).to.equal(userData);
    });

    it('should handle empty userData', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee = (amount0 * 2500n) / 1000000n;
      await token0.mint(await recipient.getAddress(), fee);
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, 0, '0x')
      ).to.not.be.reverted;
    });
  });

  // ===========================================================================
  // 4. Repayment Verification Tests
  // ===========================================================================

  describe('4. Repayment Verification', () => {
    it('should revert if token0 repayment is insufficient', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      // Fund with less than required fee
      const fee = (amount0 * 2500n) / 1000000n;
      await token0.mint(await recipient.getAddress(), fee / 2n); // Only half the fee
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, 0, '0x')
      ).to.be.revertedWith('Insufficient token0 repayment');
    });

    it('should revert if token1 repayment is insufficient', async () => {
      const { pool, token1 } = await loadFixture(deployPancakeV3Fixture);

      const amount1 = ethers.parseEther('100');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee = (amount1 * 2500n) / 1000000n;
      await token1.mint(await recipient.getAddress(), fee / 2n);
      await recipient.approveToken(
        await token1.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), 0, amount1, '0x')
      ).to.be.revertedWith('Insufficient token1 repayment');
    });

    it('should succeed with exact repayment (amount + fee)', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee = (amount0 * 2500n) / 1000000n;
      await token0.mint(await recipient.getAddress(), fee);
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, 0, '0x')
      ).to.not.be.reverted;
    });

    it('should allow overpayment', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = ethers.parseEther('100');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      // Fund with more than needed
      await token0.mint(await recipient.getAddress(), ethers.parseEther('10'));
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, 0, '0x')
      ).to.not.be.reverted;
    });
  });

  // ===========================================================================
  // 5. Pool Discovery Tests
  // ===========================================================================

  describe('5. Pool Discovery via Factory', () => {
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
        500 // This fee tier was not created
      );

      expect(nonExistentPool).to.equal(ethers.ZeroAddress);
    });

    it('should support reverse token order lookup', async () => {
      const { factory, pool, token0, token1 } = await loadFixture(deployPancakeV3Fixture);

      // PancakeSwap V3 (like Uniswap V3) canonicalizes token order
      // token0 < token1 by address
      const discoveredPool = await factory.getPool(
        await token1.getAddress(), // Reversed order
        await token0.getAddress(),
        2500
      );

      expect(discoveredPool).to.equal(await pool.getAddress());
    });
  });

  // ===========================================================================
  // 6. Documentation Consistency Tests
  // ===========================================================================

  describe('6. Documentation Consistency', () => {
    it('should verify documented fee tiers are correct', async () => {
      // Documentation states: 100, 500, 2500, 10000 (0.01%, 0.05%, 0.25%, 1%)
      const documentedTiers = [100, 500, 2500, 10000];

      for (const tier of documentedTiers) {
        const { token0, token1 } = await loadFixture(deployPancakeV3Fixture);

        const MockPancakeV3PoolFactory = await ethers.getContractFactory(
          'MockPancakeV3Pool'
        );
        const pool = await MockPancakeV3PoolFactory.deploy(
          await token0.getAddress(),
          await token1.getAddress(),
          tier
        );

        const fee = await pool.fee();
        expect(fee).to.equal(tier);
      }
    });

    it('should match example: 1000 tokens @ 0.25% = 2.5 tokens fee', async () => {
      const { pool } = await loadFixture(deployPancakeV3Fixture);

      const loanAmount = ethers.parseEther('1000');
      const poolFee = await pool.fee(); // 2500 fee units = 0.25%

      // Fee = (amount * fee) / 1000000
      const calculatedFee = (loanAmount * BigInt(poolFee)) / 1000000n;

      expect(calculatedFee).to.equal(ethers.parseEther('2.5'));
    });

    it('should verify at least one amount must be > 0', async () => {
      const { pool } = await loadFixture(deployPancakeV3Fixture);

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      // Documentation states: at least one amount must be > 0
      await expect(
        pool.flash(await recipient.getAddress(), 0, 0, '0x')
      ).to.be.revertedWith('Both amounts cannot be zero');
    });
  });

  // ===========================================================================
  // 7. Edge Cases
  // ===========================================================================

  describe('7. Edge Cases', () => {
    it('should handle very small amounts (dust)', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      const amount0 = 1000n; // 1000 wei

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee = (amount0 * 2500n) / 1000000n; // May round to 0
      await token0.mint(await recipient.getAddress(), fee + 1n); // Add 1 wei buffer
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, 0, '0x')
      ).to.not.be.reverted;
    });

    it('should handle maximum safe integer amounts', async () => {
      const { pool, token0 } = await loadFixture(deployPancakeV3Fixture);

      // Use a large but safe amount
      const amount0 = ethers.parseEther('1000000');

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      const fee = (amount0 * 2500n) / 1000000n;
      await token0.mint(await recipient.getAddress(), fee);
      await recipient.approveToken(
        await token0.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      await expect(
        pool.flash(await recipient.getAddress(), amount0, 0, '0x')
      ).to.not.be.reverted;
    });

    it('should revert if pool has insufficient liquidity', async () => {
      const { pool } = await loadFixture(deployPancakeV3Fixture);

      const MockFlashLoanRecipientFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const recipient = await MockFlashLoanRecipientFactory.deploy();

      // Request more than pool has
      const excessiveAmount = ethers.parseEther('10000000');

      await expect(
        pool.flash(await recipient.getAddress(), excessiveAmount, 0, '0x')
      ).to.be.revertedWith('Insufficient liquidity');
    });
  });
});
