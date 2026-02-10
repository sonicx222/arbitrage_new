import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { MockSyncSwapVault, MockBalancerVault, MockERC20 } from '../typechain-types';

/**
 * Interface Compliance Tests
 *
 * Verifies that interface implementations match their documentation:
 * 1. Fee calculations match documented formulas
 * 2. Array validation matches documented requirements
 * 3. Error messages match documented revert strings
 *
 * These tests ensure documentation stays in sync with implementation.
 *
 * @see contracts/INTERFACE_FIXES_APPLIED.md
 * @see contracts/src/interfaces/FLASH_LOAN_ERRORS.md
 */
describe('Interface Compliance', () => {
  // ===========================================================================
  // Test Fixtures
  // ===========================================================================

  async function deploySyncSwapVaultFixture() {
    const [owner] = await ethers.getSigners();

    // Deploy mock WETH
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const weth = await MockERC20Factory.deploy('Wrapped Ether', 'WETH', 18);

    // Deploy MockSyncSwapVault
    const MockSyncSwapVaultFactory = await ethers.getContractFactory('MockSyncSwapVault');
    const vault = await MockSyncSwapVaultFactory.deploy(await weth.getAddress());

    // Fund vault for flash loans
    await weth.mint(await vault.getAddress(), ethers.parseEther('10000'));

    return { vault, weth, owner };
  }

  async function deployBalancerVaultFixture() {
    const [owner] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const token1 = await MockERC20Factory.deploy('Token1', 'TK1', 18);
    const token2 = await MockERC20Factory.deploy('Token2', 'TK2', 18);

    // Deploy MockBalancerVault
    const MockBalancerVaultFactory = await ethers.getContractFactory('MockBalancerVault');
    const vault = await MockBalancerVaultFactory.deploy();

    // Fund vault for flash loans
    await token1.mint(await vault.getAddress(), ethers.parseEther('10000'));
    await token2.mint(await vault.getAddress(), ethers.parseEther('10000'));

    // Deploy a mock recipient contract for flash loan tests
    const MockFlashLoanRecipientFactory = await ethers.getContractFactory('MockFlashLoanRecipient');
    const recipient = await MockFlashLoanRecipientFactory.deploy();

    return { vault, token1, token2, recipient, owner };
  }

  // ===========================================================================
  // 1. SyncSwap Fee Calculation Tests
  // ===========================================================================

  describe('1. SyncSwap Fee Calculation (ISyncSwapVault)', () => {
    it('should calculate fee as 0.3% of loan amount', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      const loanAmount = ethers.parseEther('1000');
      const expectedFee = loanAmount * 3n / 1000n; // 0.3%

      const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

      expect(actualFee).to.equal(expectedFee);
      expect(actualFee).to.equal(ethers.parseEther('3')); // 3 ETH
    });

    it('should return fee percentage as 3e15 (0.3% with 18 decimals)', async () => {
      const { vault } = await loadFixture(deploySyncSwapVaultFixture);

      const feePercentage = await vault.flashLoanFeePercentage();

      // 0.003 * 1e18 = 3e15
      expect(feePercentage).to.equal(3000000000000000n);
      expect(feePercentage).to.equal(ethers.parseEther('0.003'));
    });

    it('should calculate fee correctly for small amounts', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      const loanAmount = ethers.parseEther('1'); // 1 ETH
      const expectedFee = loanAmount * 3n / 1000n; // 0.003 ETH

      const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

      expect(actualFee).to.equal(expectedFee);
      expect(actualFee).to.equal(ethers.parseEther('0.003'));
    });

    it('should calculate fee correctly for large amounts', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      const loanAmount = ethers.parseEther('1000000'); // 1M ETH
      const expectedFee = loanAmount * 3n / 1000n; // 3000 ETH

      const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

      expect(actualFee).to.equal(expectedFee);
      expect(actualFee).to.equal(ethers.parseEther('3000'));
    });

    it('should handle rounding for very small amounts', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      const loanAmount = 100n; // 100 wei
      const expectedFee = (loanAmount * 3n) / 1000n; // 0 wei (rounds down)

      const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

      expect(actualFee).to.equal(expectedFee);
      expect(actualFee).to.equal(0n);
    });
  });

  // ===========================================================================
  // 2. Balancer V2 Array Validation Tests
  // ===========================================================================

  describe('2. Balancer V2 Array Validation (IBalancerV2Vault)', () => {
    it('should revert with "Array length mismatch" for mismatched array lengths', async () => {
      const { vault, token1, token2, recipient } = await loadFixture(deployBalancerVaultFixture);

      const tokens = [await token1.getAddress(), await token2.getAddress()];
      const amounts = [ethers.parseEther('100')]; // Only 1 amount for 2 tokens

      await expect(
        vault.flashLoan(
          await recipient.getAddress(),
          tokens,
          amounts,
          '0x'
        )
      ).to.be.revertedWith('Array length mismatch');
    });

    it('should revert with "Empty arrays" for empty arrays', async () => {
      const { vault, recipient } = await loadFixture(deployBalancerVaultFixture);

      const tokens: string[] = [];
      const amounts: bigint[] = [];

      await expect(
        vault.flashLoan(
          await recipient.getAddress(),
          tokens,
          amounts,
          '0x'
        )
      ).to.be.revertedWith('Empty arrays');
    });

    it('should revert with "Zero amount" for zero amount in array', async () => {
      const { vault, token1, recipient } = await loadFixture(deployBalancerVaultFixture);

      const tokens = [await token1.getAddress()];
      const amounts = [0n]; // Zero amount

      await expect(
        vault.flashLoan(
          await recipient.getAddress(),
          tokens,
          amounts,
          '0x'
        )
      ).to.be.revertedWith('Zero amount');
    });

    it('should revert with "Zero amount" when one of multiple amounts is zero', async () => {
      const { vault, token1, token2, recipient } = await loadFixture(deployBalancerVaultFixture);

      const tokens = [await token1.getAddress(), await token2.getAddress()];
      const amounts = [ethers.parseEther('100'), 0n]; // Second amount is zero

      await expect(
        vault.flashLoan(
          await recipient.getAddress(),
          tokens,
          amounts,
          '0x'
        )
      ).to.be.revertedWith('Zero amount');
    });

    it('should succeed with valid arrays (single token)', async () => {
      const { vault, token1, recipient } = await loadFixture(deployBalancerVaultFixture);

      const tokens = [await token1.getAddress()];
      const amounts = [ethers.parseEther('100')];

      // MockFlashLoanRecipient is designed to succeed
      await expect(
        vault.flashLoan(
          await recipient.getAddress(),
          tokens,
          amounts,
          '0x'
        )
      ).to.not.be.reverted;
    });

    it('should succeed with valid arrays (multiple tokens)', async () => {
      const { vault, token1, token2, recipient } = await loadFixture(deployBalancerVaultFixture);

      const tokens = [await token1.getAddress(), await token2.getAddress()];
      const amounts = [ethers.parseEther('100'), ethers.parseEther('200')];

      await expect(
        vault.flashLoan(
          await recipient.getAddress(),
          tokens,
          amounts,
          '0x'
        )
      ).to.not.be.reverted;
    });
  });

  // ===========================================================================
  // 3. Documentation Consistency Tests
  // ===========================================================================

  describe('3. Documentation Consistency', () => {
    it('SyncSwap: Fee formula matches documentation', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      // Documentation states: fee = (amount * 0.003) or (amount * flashLoanFeePercentage()) / 1e18
      const amount = ethers.parseEther('1000');

      // Method 1: (amount * 0.003)
      const feeMethod1 = amount * 3n / 1000n;

      // Method 2: (amount * flashLoanFeePercentage()) / 1e18
      const feePercentage = await vault.flashLoanFeePercentage();
      const feeMethod2 = (amount * feePercentage) / ethers.parseEther('1');

      // Both methods should give same result
      expect(feeMethod1).to.equal(feeMethod2);

      // Actual implementation should match
      const actualFee = await vault.flashFee(await weth.getAddress(), amount);
      expect(actualFee).to.equal(feeMethod1);
      expect(actualFee).to.equal(feeMethod2);
    });

    it('SyncSwap: Documented example (1000 ETH → 3 ETH fee) is accurate', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      // Example from ISyncSwapVault.sol documentation:
      // "1000 ETH loan → 3 ETH fee (0.3%)"
      const loanAmount = ethers.parseEther('1000');
      const expectedFee = ethers.parseEther('3');

      const actualFee = await vault.flashFee(await weth.getAddress(), loanAmount);

      expect(actualFee).to.equal(expectedFee);
    });

    it('Balancer: All documented error messages are accurate', async () => {
      const { vault, token1, token2, recipient } = await loadFixture(deployBalancerVaultFixture);

      // Test each documented error message
      const errorTests = [
        {
          name: 'Array length mismatch',
          tokens: [await token1.getAddress(), await token2.getAddress()],
          amounts: [ethers.parseEther('100')],
          expectedError: 'Array length mismatch',
        },
        {
          name: 'Empty arrays',
          tokens: [],
          amounts: [],
          expectedError: 'Empty arrays',
        },
        {
          name: 'Zero amount',
          tokens: [await token1.getAddress()],
          amounts: [0n],
          expectedError: 'Zero amount',
        },
      ];

      for (const test of errorTests) {
        await expect(
          vault.flashLoan(
            await recipient.getAddress(),
            test.tokens,
            test.amounts,
            '0x'
          )
        ).to.be.revertedWith(test.expectedError, `Failed test: ${test.name}`);
      }
    });
  });

  // ===========================================================================
  // 4. EIP-3156 Compliance Tests
  // ===========================================================================

  describe('4. EIP-3156 Compliance (SyncSwap)', () => {
    it('should implement EIP-3156 flashFee interface', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      // EIP-3156 requires flashFee(address token, uint256 amount) → uint256
      const amount = ethers.parseEther('100');
      const fee = await vault.flashFee(await weth.getAddress(), amount);

      expect(fee).to.be.a('bigint');
      expect(fee).to.be.greaterThan(0n);
    });

    it('should implement EIP-3156 maxFlashLoan interface', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      // EIP-3156 requires maxFlashLoan(address token) → uint256
      const maxLoan = await vault.maxFlashLoan(await weth.getAddress());

      expect(maxLoan).to.be.a('bigint');
      expect(maxLoan).to.equal(ethers.parseEther('10000')); // Vault was funded with 10000 ETH
    });

    it('should calculate fee independent of maxFlashLoan', async () => {
      const { vault, weth } = await loadFixture(deploySyncSwapVaultFixture);

      const maxLoan = await vault.maxFlashLoan(await weth.getAddress());
      const feeForMax = await vault.flashFee(await weth.getAddress(), maxLoan);

      // Fee should be 0.3% of amount, not related to vault balance
      const expectedFee = (maxLoan * 3n) / 1000n;
      expect(feeForMax).to.equal(expectedFee);
    });
  });
});
