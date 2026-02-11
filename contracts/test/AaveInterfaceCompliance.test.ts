import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { MockAavePool, MockERC20 } from '../typechain-types';

/**
 * Aave V3 Interface Compliance Tests
 *
 * Verifies that IFlashLoanReceiver interface implementation matches documentation:
 * 1. Fee calculation (0.09% = 9 basis points)
 * 2. executeOperation return value handling
 * 3. Callback validation
 * 4. Repayment verification
 *
 * @see contracts/src/interfaces/IFlashLoanReceiver.sol
 * @see contracts/INTERFACE_FIXES_APPLIED.md
 */
describe('Aave V3 Interface Compliance', () => {
  // ===========================================================================
  // Test Fixtures
  // ===========================================================================

  async function deployAavePoolFixture() {
    const [owner, borrower] = await ethers.getSigners();

    // Deploy mock token
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const token = await MockERC20Factory.deploy('Test Token', 'TEST', 18);

    // Deploy MockAavePool
    const MockAavePoolFactory = await ethers.getContractFactory('MockAavePool');
    const pool = await MockAavePoolFactory.deploy();

    // Fund pool for flash loans
    await token.mint(await pool.getAddress(), ethers.parseEther('1000000'));

    return { pool, token, owner, borrower };
  }

  // ===========================================================================
  // 1. Fee Calculation Tests
  // ===========================================================================

  describe('1. Flash Loan Fee Calculation', () => {
    it('should calculate premium as 0.09% (9 basis points)', async () => {
      const { pool } = await loadFixture(deployAavePoolFixture);

      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();

      // Aave V3 fee: 0.09% = 9 basis points = 0.0009 decimal
      expect(premium).to.equal(9);
    });

    it('should calculate correct fee for 1000 token loan', async () => {
      const { pool } = await loadFixture(deployAavePoolFixture);

      const loanAmount = ethers.parseEther('1000');
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();

      // Fee = (amount * premium) / 10000
      // Fee = (1000 * 9) / 10000 = 0.9 tokens
      const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

      expect(expectedFee).to.equal(ethers.parseEther('0.9'));
    });

    it('should calculate correct fee for small amounts', async () => {
      const { pool } = await loadFixture(deployAavePoolFixture);

      const loanAmount = ethers.parseEther('1');
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();

      // Fee = (1 * 9) / 10000 = 0.0009 tokens
      const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

      expect(expectedFee).to.equal(ethers.parseEther('0.0009'));
    });

    it('should calculate correct fee for large amounts', async () => {
      const { pool } = await loadFixture(deployAavePoolFixture);

      const loanAmount = ethers.parseEther('1000000'); // 1M tokens
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();

      // Fee = (1000000 * 9) / 10000 = 900 tokens
      const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

      expect(expectedFee).to.equal(ethers.parseEther('900'));
    });

    it('should handle rounding for very small amounts', async () => {
      const { pool } = await loadFixture(deployAavePoolFixture);

      const loanAmount = 1000n; // 1000 wei
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();

      // Fee = (1000 * 9) / 10000 = 0 (rounds down)
      const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

      expect(expectedFee).to.equal(0n);
    });
  });

  // ===========================================================================
  // 2. Return Value Handling Tests
  // ===========================================================================

  describe('2. executeOperation Return Value', () => {
    it('should revert if executeOperation returns false', async () => {
      const { pool, token, borrower } = await loadFixture(deployAavePoolFixture);

      // Deploy a mock receiver that returns false
      const MockFailingReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockFailingReceiverFactory.deploy();

      // Configure receiver to return false
      await receiver.setShouldSucceed(false);

      const loanAmount = ethers.parseEther('100');

      // Flash loan should revert because receiver returns false
      await expect(
        pool.flashLoanSimple(
          await receiver.getAddress(),
          await token.getAddress(),
          loanAmount,
          '0x',
          0
        )
      ).to.be.revertedWith('Flash loan execution failed');
    });

    it('should succeed if executeOperation returns true', async () => {
      const { pool, token, borrower } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();

      // Configure receiver to succeed
      await receiver.setShouldSucceed(true);

      const loanAmount = ethers.parseEther('100');

      // Approve receiver to repay
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
          loanAmount,
          '0x',
          0
        )
      ).to.not.be.reverted;
    });
  });

  // ===========================================================================
  // 3. Callback Validation Tests
  // ===========================================================================

  describe('3. Callback Validation', () => {
    it('should pass correct parameters to executeOperation', async () => {
      const { pool, token, borrower } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(true);

      const loanAmount = ethers.parseEther('100');
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
      const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

      // Fund and approve
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

      // Verify callback was called with correct parameters
      // (MockFlashLoanRecipient should record the call)
      const lastAsset = await receiver.lastAsset();
      const lastAmount = await receiver.lastAmount();
      const lastPremium = await receiver.lastPremium();

      expect(lastAsset).to.equal(await token.getAddress());
      expect(lastAmount).to.equal(loanAmount);
      expect(lastPremium).to.equal(expectedFee);
    });

    it('should revert if callback reverts', async () => {
      const { pool, token } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();

      // Configure receiver to revert
      await receiver.setShouldRevert(true);

      const loanAmount = ethers.parseEther('100');

      await expect(
        pool.flashLoanSimple(
          await receiver.getAddress(),
          await token.getAddress(),
          loanAmount,
          '0x',
          0
        )
      ).to.be.reverted;
    });
  });

  // ===========================================================================
  // 4. Repayment Verification Tests
  // ===========================================================================

  describe('4. Repayment Verification', () => {
    it('should revert if repayment is insufficient', async () => {
      const { pool, token } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(true);

      const loanAmount = ethers.parseEther('100');

      // Don't pre-fund receiver: it only receives the flash-loaned 100 ETH,
      // but must repay 100 + 0.09 (premium) = 100.09 ETH via safeTransferFrom.
      // Since 100 < 100.09, the ERC20 transfer will revert.
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
      ).to.be.reverted;
    });

    it('should succeed if repayment is exact (amount + fee)', async () => {
      const { pool, token } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(true);

      const loanAmount = ethers.parseEther('100');
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
      const fee = (loanAmount * BigInt(premium)) / 10000n;

      // Fund receiver with exact repayment amount
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

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(true);

      const loanAmount = ethers.parseEther('100');

      // Fund receiver with more than needed
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

      // Pool should have gained at least the fee
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
      const expectedFee = (loanAmount * BigInt(premium)) / 10000n;

      expect(poolBalanceAfter - poolBalanceBefore).to.be.gte(expectedFee);
    });
  });

  // ===========================================================================
  // 5. Documentation Consistency Tests
  // ===========================================================================

  describe('5. Documentation Consistency', () => {
    it('should match documented fee (0.09%)', async () => {
      const { pool } = await loadFixture(deployAavePoolFixture);

      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();

      // Documentation states: 0.09% = 9 basis points
      expect(premium).to.equal(9);
    });

    it('should match example: 1000 tokens → 0.9 tokens fee', async () => {
      const { pool } = await loadFixture(deployAavePoolFixture);

      const loanAmount = ethers.parseEther('1000');
      const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
      const fee = (loanAmount * BigInt(premium)) / 10000n;

      // Example from documentation: 1000 tokens loan → 0.9 tokens fee
      expect(fee).to.equal(ethers.parseEther('0.9'));
    });

    it('should verify returning false causes revert (not silent fail)', async () => {
      const { pool, token } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(false); // Return false

      const loanAmount = ethers.parseEther('100');

      // Verify that returning false causes revert (not silent failure)
      await expect(
        pool.flashLoanSimple(
          await receiver.getAddress(),
          await token.getAddress(),
          loanAmount,
          '0x',
          0
        )
      ).to.be.reverted;
    });
  });

  // ===========================================================================
  // 6. Edge Case Tests
  // ===========================================================================

  describe('6. Edge Cases', () => {
    it('should handle zero amount loan', async () => {
      const { pool, token } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(true);

      // Zero amount loan should still call callback
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

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(true);

      const loanAmount = ethers.parseEther('100');

      // Fund and approve with max uint256
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
          loanAmount,
          '0x',
          0
        )
      ).to.not.be.reverted;
    });

    it('should handle empty userData', async () => {
      const { pool, token } = await loadFixture(deployAavePoolFixture);

      const MockReceiverFactory = await ethers.getContractFactory(
        'MockFlashLoanRecipient'
      );
      const receiver = await MockReceiverFactory.deploy();
      await receiver.setShouldSucceed(true);

      const loanAmount = ethers.parseEther('100');

      await token.mint(await receiver.getAddress(), ethers.parseEther('1'));
      await receiver.approveToken(
        await token.getAddress(),
        await pool.getAddress(),
        ethers.MaxUint256
      );

      // Empty userData should work
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
  });
});
