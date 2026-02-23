/**
 * Tests for HD Wallet Manager
 *
 * Verifies BIP-44 per-chain wallet derivation from mnemonic.
 *
 * @see Phase 0 Item 4: Per-chain HD wallets (BIP-44 derivation)
 */

import { ethers } from 'ethers';
import {
  derivePerChainWallets,
  getDerivationPath,
  validateMnemonic,
  CHAIN_DERIVATION_INDEX,
} from '../../../src/services/hd-wallet-manager';

// Well-known test mnemonic (from ethers/hardhat defaults — NEVER use for real funds)
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

describe('HD Wallet Manager', () => {
  describe('CHAIN_DERIVATION_INDEX', () => {
    it('should have unique indices for all EVM chains', () => {
      const indices = Object.values(CHAIN_DERIVATION_INDEX);
      const uniqueIndices = new Set(indices);
      expect(uniqueIndices.size).toBe(indices.length);
    });

    it('should include all expected EVM chains', () => {
      const expectedChains = [
        'ethereum', 'bsc', 'arbitrum', 'polygon', 'optimism',
        'avalanche', 'fantom', 'base', 'zksync', 'linea',
      ];
      for (const chain of expectedChains) {
        expect(CHAIN_DERIVATION_INDEX).toHaveProperty(chain);
      }
    });

    it('should NOT include solana (non-EVM)', () => {
      expect(CHAIN_DERIVATION_INDEX).not.toHaveProperty('solana');
    });

    it('should use sequential indices starting from 0', () => {
      const indices = Object.values(CHAIN_DERIVATION_INDEX).sort((a, b) => a - b);
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBe(i);
      }
    });
  });

  describe('derivePerChainWallets', () => {
    it('should derive unique addresses for each chain from a mnemonic', () => {
      const logger = createMockLogger();
      const chains = ['ethereum', 'bsc', 'arbitrum', 'polygon'];

      const wallets = derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC },
        chains,
        logger,
      );

      expect(wallets.size).toBe(4);

      // All addresses should be unique
      const addresses = new Set<string>();
      for (const [, wallet] of wallets) {
        expect(wallet.address).toBeDefined();
        expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        addresses.add(wallet.address);
      }
      expect(addresses.size).toBe(4);
    });

    it('should produce deterministic addresses (same mnemonic = same addresses)', () => {
      const logger = createMockLogger();
      const chains = ['ethereum', 'bsc'];

      const wallets1 = derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC },
        chains,
        logger,
      );
      const wallets2 = derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC },
        chains,
        logger,
      );

      expect(wallets1.get('ethereum')!.address).toBe(wallets2.get('ethereum')!.address);
      expect(wallets1.get('bsc')!.address).toBe(wallets2.get('bsc')!.address);
    });

    it('should skip non-EVM chains (e.g., solana)', () => {
      const logger = createMockLogger();
      const chains = ['ethereum', 'solana'];

      const wallets = derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC },
        chains,
        logger,
      );

      expect(wallets.size).toBe(1);
      expect(wallets.has('ethereum')).toBe(true);
      expect(wallets.has('solana')).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping HD derivation for solana'),
      );
    });

    it('should throw on invalid mnemonic', () => {
      const logger = createMockLogger();

      expect(() =>
        derivePerChainWallets(
          { mnemonic: 'invalid words that are not a real mnemonic phrase at all' },
          ['ethereum'],
          logger,
        ),
      ).toThrow('Invalid WALLET_MNEMONIC');
    });

    it('should use correct BIP-44 derivation paths', () => {
      const logger = createMockLogger();
      const chains = ['ethereum', 'arbitrum'];

      const wallets = derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC },
        chains,
        logger,
      );

      // Verify by independently deriving with ethers fromSeed
      const mnemonic = ethers.Mnemonic.fromPhrase(TEST_MNEMONIC);
      const rootNode = ethers.HDNodeWallet.fromSeed(mnemonic.computeSeed());
      const ethWallet = rootNode.derivePath("m/44'/60'/0'/0/0");
      const arbWallet = rootNode.derivePath("m/44'/60'/0'/0/2");

      expect(wallets.get('ethereum')!.address).toBe(ethWallet.address);
      expect(wallets.get('arbitrum')!.address).toBe(arbWallet.address);
    });

    it('should derive different addresses with passphrase', () => {
      const logger = createMockLogger();
      const chains = ['ethereum'];

      const withoutPassphrase = derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC },
        chains,
        logger,
      );
      const withPassphrase = derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC, passphrase: 'my-secret-passphrase' },
        chains,
        logger,
      );

      expect(withoutPassphrase.get('ethereum')!.address)
        .not.toBe(withPassphrase.get('ethereum')!.address);
    });

    it('should log wallet initialization for each derived chain', () => {
      const logger = createMockLogger();
      derivePerChainWallets(
        { mnemonic: TEST_MNEMONIC },
        ['ethereum', 'bsc'],
        logger,
      );

      expect(logger.info).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Derived HD wallet for ethereum'),
        expect.objectContaining({ index: 0 }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Derived HD wallet for bsc'),
        expect.objectContaining({ index: 1 }),
      );
    });
  });

  describe('getDerivationPath', () => {
    it('should return correct BIP-44 path for EVM chains', () => {
      expect(getDerivationPath('ethereum')).toBe("m/44'/60'/0'/0/0");
      expect(getDerivationPath('bsc')).toBe("m/44'/60'/0'/0/1");
      expect(getDerivationPath('arbitrum')).toBe("m/44'/60'/0'/0/2");
      expect(getDerivationPath('base')).toBe("m/44'/60'/0'/0/7");
    });

    it('should return undefined for non-EVM chains', () => {
      expect(getDerivationPath('solana')).toBeUndefined();
      expect(getDerivationPath('unknown')).toBeUndefined();
    });
  });

  describe('validateMnemonic', () => {
    it('should accept valid 12-word mnemonic', () => {
      expect(validateMnemonic(TEST_MNEMONIC)).toBe(true);
    });

    it('should reject invalid mnemonic', () => {
      expect(validateMnemonic('not a valid mnemonic')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(validateMnemonic('')).toBe(false);
    });
  });
});
