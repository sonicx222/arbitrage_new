/**
 * Tests for Solana Transaction Builder
 *
 * @see Phase 3 #29: Solana Execution with Jito Bundles
 */

import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
} from '@solana/web3.js';
import { SolanaTransactionBuilder } from '../../../src/solana/transaction-builder';

// =============================================================================
// Mocks
// =============================================================================

jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  })),
}));

const TEST_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVmkdzGzTRQKn5WcnXwZCA',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

/**
 * Create a minimal valid base64-encoded versioned transaction for testing.
 */
function createTestVersionedTxBase64(payer: Keypair): string {
  // Create a simple SOL transfer instruction
  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey(TEST_TIP_ACCOUNTS[0]),
    lamports: 100,
  });

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [transferIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  // Sign with payer so it's a valid serializable transaction
  tx.sign([payer]);

  return Buffer.from(tx.serialize()).toString('base64');
}

// =============================================================================
// Tests
// =============================================================================

describe('SolanaTransactionBuilder', () => {
  let builder: SolanaTransactionBuilder;

  beforeEach(() => {
    builder = new SolanaTransactionBuilder(
      { tipAccounts: TEST_TIP_ACCOUNTS },
      createMockLogger(),
    );
  });

  // ===========================================================================
  // Constructor validation
  // ===========================================================================

  describe('constructor', () => {
    it('should create builder with valid tip accounts', () => {
      expect(builder).toBeInstanceOf(SolanaTransactionBuilder);
    });

    it('should throw when no tip accounts provided', () => {
      expect(
        () => new SolanaTransactionBuilder({ tipAccounts: [] }, createMockLogger()),
      ).toThrow('At least one Jito tip account is required');
    });
  });

  // ===========================================================================
  // getRandomTipAccount
  // ===========================================================================

  describe('getRandomTipAccount', () => {
    it('should return a valid PublicKey from configured accounts', () => {
      const tipAccount = builder.getRandomTipAccount();

      expect(tipAccount).toBeInstanceOf(PublicKey);

      // Must be one of the configured tip accounts
      const base58Addresses = TEST_TIP_ACCOUNTS;
      expect(base58Addresses).toContain(tipAccount.toBase58());
    });

    it('should return different accounts over many calls (randomness)', () => {
      const seen = new Set<string>();
      // With 8 accounts, 100 calls should hit at least 2 different accounts
      for (let i = 0; i < 100; i++) {
        seen.add(builder.getRandomTipAccount().toBase58());
      }
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  // ===========================================================================
  // buildBundleTransaction
  // ===========================================================================

  describe('buildBundleTransaction', () => {
    it('should deserialize Jupiter tx, add tip, and return signed VersionedTransaction', async () => {
      const walletKeypair = Keypair.generate();
      const jupiterTxBase64 = createTestVersionedTxBase64(walletKeypair);

      const result = await builder.buildBundleTransaction(
        jupiterTxBase64,
        walletKeypair,
        1_000_000,
      );

      expect(result).toBeInstanceOf(VersionedTransaction);

      // The new transaction should have more instructions than the original (original + tip)
      // Original has 1 instruction, new should have 2 (transfer + tip)
      const compiledInstructions = result.message.compiledInstructions;
      expect(compiledInstructions.length).toBe(2);
    });

    it('should throw on invalid base64 input', async () => {
      const walletKeypair = Keypair.generate();

      await expect(
        builder.buildBundleTransaction('not-valid-base64!!!', walletKeypair, 1_000_000),
      ).rejects.toThrow();
    });
  });
});
