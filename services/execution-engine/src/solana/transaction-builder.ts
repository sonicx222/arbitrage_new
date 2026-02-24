/**
 * Solana Transaction Builder
 *
 * Composes bundle-ready Solana versioned transactions by combining
 * Jupiter swap transactions with Jito validator tip instructions.
 *
 * The builder deserializes Jupiter's base64-encoded swap transaction,
 * appends a tip transfer to a random Jito tip account, and re-signs
 * the modified transaction with the wallet keypair.
 *
 * @see Phase 3 #29: Solana Execution with Jito Bundles
 */

import {
  VersionedTransaction,
  Keypair,
  SystemProgram,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { createLogger, type Logger } from '@arbitrage/core';

// =============================================================================
// Types
// =============================================================================

export interface TransactionBuilderConfig {
  /** Jito tip accounts (8 addresses, one selected randomly per bundle) */
  tipAccounts: string[];
}

// =============================================================================
// Solana Transaction Builder
// =============================================================================

/**
 * Builds bundle-ready Solana versioned transactions.
 *
 * Workflow:
 * 1. Deserialize Jupiter's base64 versioned transaction
 * 2. Add Jito tip transfer instruction
 * 3. Re-sign with wallet keypair
 */
export class SolanaTransactionBuilder {
  private readonly tipAccounts: PublicKey[];
  private readonly logger: Logger;

  constructor(config: TransactionBuilderConfig, logger?: Logger) {
    if (!config.tipAccounts || config.tipAccounts.length === 0) {
      throw new Error('At least one Jito tip account is required');
    }

    this.tipAccounts = config.tipAccounts.map((addr) => new PublicKey(addr));
    this.logger = logger ?? createLogger('solana-tx-builder');
  }

  /**
   * Build a bundle-ready transaction by adding a Jito tip to Jupiter's swap tx.
   *
   * Steps:
   * 1. Deserialize the base64 versioned transaction from Jupiter
   * 2. Create a SOL transfer instruction for the Jito tip
   * 3. Combine existing instructions with tip instruction
   * 4. Build a new versioned transaction and sign it
   *
   * @param jupiterSwapTxBase64 - Base64-encoded versioned transaction from Jupiter
   * @param walletKeypair - Wallet keypair for signing
   * @param tipLamports - Tip amount in lamports for Jito validator
   * @param lookupTableAccounts - Address Lookup Table accounts for resolving compressed keys.
   *   Required when Jupiter's swap tx uses ALTs (most complex routes do).
   *   Fetch these from on-chain via connection.getAddressLookupTable() for each
   *   ALT address in the original transaction's addressTableLookups.
   * @returns Signed versioned transaction ready for bundle submission
   */
  async buildBundleTransaction(
    jupiterSwapTxBase64: string,
    walletKeypair: Keypair,
    tipLamports: number,
    lookupTableAccounts?: AddressLookupTableAccount[],
  ): Promise<VersionedTransaction> {
    this.logger.debug('Building bundle transaction', {
      tipLamports,
      wallet: walletKeypair.publicKey.toBase58(),
    });

    // 1. Deserialize Jupiter's versioned transaction
    const swapTxBuffer = Buffer.from(jupiterSwapTxBase64, 'base64');
    const originalTx = VersionedTransaction.deserialize(swapTxBuffer);

    // 2. Create Jito tip instruction
    const tipAccount = this.getRandomTipAccount();
    const tipInstruction = SystemProgram.transfer({
      fromPubkey: walletKeypair.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });

    this.logger.debug('Tip instruction created', {
      tipAccount: tipAccount.toBase58(),
      tipLamports,
    });

    // 3. Decompile the original message to get instructions
    // For versioned transactions, we need to extract the message and add our instruction
    const originalMessage = originalTx.message;

    // Get the existing instructions and address table lookups
    const addressTableLookups = originalMessage.addressTableLookups ?? [];

    if (addressTableLookups.length > 0 && !lookupTableAccounts?.length) {
      this.logger.warn('Jupiter tx uses Address Lookup Tables but none were provided — ALTs will be lost', {
        altCount: addressTableLookups.length,
      });
    }

    // Build a new message with the tip instruction appended
    // We extract the compiled instructions and add the tip transfer
    const existingInstructions = this.decompileInstructions(originalMessage);
    const allInstructions = [...existingInstructions, tipInstruction];

    // 4. Create new versioned transaction with all instructions.
    // Pass ALT accounts so compileToV0Message can compress addresses.
    const newMessage = new TransactionMessage({
      payerKey: walletKeypair.publicKey,
      recentBlockhash: originalMessage.recentBlockhash,
      instructions: allInstructions,
    }).compileToV0Message(
      lookupTableAccounts?.length ? lookupTableAccounts : undefined,
    );

    const newTx = new VersionedTransaction(newMessage);

    // 5. Sign with wallet keypair
    newTx.sign([walletKeypair]);

    this.logger.debug('Bundle transaction built and signed', {
      instructionCount: allInstructions.length,
    });

    return newTx;
  }

  /**
   * Select a random Jito tip account.
   *
   * @returns PublicKey of a randomly selected tip account
   */
  getRandomTipAccount(): PublicKey {
    const index = Math.floor(Math.random() * this.tipAccounts.length);
    return this.tipAccounts[index];
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Decompile a versioned transaction message into TransactionInstruction[].
   *
   * Extracts program IDs, accounts, and data from the compiled message format
   * back into the standard TransactionInstruction interface.
   */
  private decompileInstructions(
    message: VersionedTransaction['message'],
  ): TransactionInstruction[] {
    const instructions: TransactionInstruction[] = [];
    const accountKeys = message.staticAccountKeys;

    for (const compiledIx of message.compiledInstructions) {
      const programId = accountKeys[compiledIx.programIdIndex];

      const keys = compiledIx.accountKeyIndexes.map((index) => ({
        pubkey: accountKeys[index],
        isSigner: message.isAccountSigner(index),
        isWritable: message.isAccountWritable(index),
      }));

      instructions.push(
        new TransactionInstruction({
          programId,
          keys,
          data: Buffer.from(compiledIx.data),
        }),
      );
    }

    return instructions;
  }
}
