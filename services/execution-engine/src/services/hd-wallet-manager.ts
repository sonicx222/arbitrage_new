/**
 * HD Wallet Manager
 *
 * Derives per-chain wallets from a BIP-44 HD wallet mnemonic.
 * Each chain gets a unique derivation index, so compromising one chain's
 * private key doesn't affect others.
 *
 * BIP-44 path: m/44'/60'/0'/0/{chainIndex}
 *  - 44' = BIP-44 purpose
 *  - 60' = Ethereum coin type (used for all EVM chains)
 *  - 0'  = first account
 *  - 0   = external chain
 *  - {chainIndex} = per-chain address index (see CHAIN_DERIVATION_INDEX)
 *
 * Per-chain `{CHAIN}_PRIVATE_KEY` env vars override HD derivation for that chain.
 *
 * @see Phase 0 Item 4: Per-chain HD wallets (BIP-44 derivation)
 * @see docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md Section 7.1.1
 */

import { ethers } from 'ethers';
import type { Logger } from '../types';
import { getErrorMessage } from '@arbitrage/core';

/**
 * Stable chain-to-derivation-index mapping.
 * IMPORTANT: These indices MUST NEVER change once deployed — changing them
 * would derive different addresses and strand funds.
 *
 * Indices are assigned in order of chain addition to the system.
 * New chains are appended at the end.
 */
export const CHAIN_DERIVATION_INDEX: Record<string, number> = {
  ethereum: 0,
  bsc: 1,
  arbitrum: 2,
  polygon: 3,
  optimism: 4,
  avalanche: 5,
  fantom: 6,
  base: 7,
  zksync: 8,
  linea: 9,
  // Solana uses Ed25519, not secp256k1 — HD derivation path is different.
  // Solana wallets must be provided via SOLANA_PRIVATE_KEY env var.
  // solana: excluded (non-EVM)
};

/** BIP-44 base path for EVM chains (coin type 60 = Ethereum). */
const BIP44_BASE_PATH = "m/44'/60'/0'/0";

export interface HDWalletConfig {
  /** BIP-39 mnemonic phrase (12 or 24 words). */
  mnemonic: string;
  /** Optional passphrase for mnemonic (BIP-39 extension). */
  passphrase?: string;
}

export interface DerivedWallet {
  chainName: string;
  wallet: ethers.HDNodeWallet;
  derivationPath: string;
  index: number;
}

/**
 * Derives per-chain wallets from a BIP-44 HD mnemonic.
 *
 * @param config - HD wallet configuration (mnemonic + optional passphrase)
 * @param chainNames - Chain names to derive wallets for (only EVM chains supported)
 * @param logger - Logger instance
 * @returns Map of chain name to derived HDNodeWallet
 */
export function derivePerChainWallets(
  config: HDWalletConfig,
  chainNames: string[],
  logger: Logger,
): Map<string, ethers.HDNodeWallet> {
  const wallets = new Map<string, ethers.HDNodeWallet>();

  // Validate mnemonic
  let mnemonic: ethers.Mnemonic;
  try {
    mnemonic = ethers.Mnemonic.fromPhrase(config.mnemonic, config.passphrase);
  } catch (error) {
    logger.error('Invalid HD wallet mnemonic', {
      wordCount: config.mnemonic.trim().split(/\s+/).length,
      error: getErrorMessage(error),
    });
    throw new Error('Invalid WALLET_MNEMONIC: mnemonic phrase is not valid BIP-39');
  }

  // Derive base node at BIP-44 path m/44'/60'/0'/0
  // In ethers v6, HDNodeWallet.fromMnemonic() derives to a default path (depth 5).
  // We use fromSeed() to get the true root, then derive to our base path once.
  // Each chain wallet is then derived by appending the chain index (one level).
  const seedHex = mnemonic.computeSeed();
  const seed = ethers.getBytes(seedHex);
  const rootNode = ethers.HDNodeWallet.fromSeed(seed);
  const baseNode = rootNode.derivePath(BIP44_BASE_PATH);

  // Security: Zero the seed bytes immediately after derivation to minimize
  // exposure of sensitive key material in memory.
  // @see docs/reports/PHASE1_DEEP_ANALYSIS_2026-02-22.md Finding #4
  seed.fill(0);

  for (const chainName of chainNames) {
    const index = CHAIN_DERIVATION_INDEX[chainName];
    if (index === undefined) {
      // Non-EVM chain (e.g., Solana) — skip HD derivation
      logger.debug(`Skipping HD derivation for ${chainName} (no EVM derivation index)`);
      continue;
    }

    const derivationPath = `${BIP44_BASE_PATH}/${index}`;
    try {
      // Derive from base node — just one level (the chain index)
      const derived = baseNode.deriveChild(index);
      wallets.set(chainName, derived);
      logger.info(`Derived HD wallet for ${chainName}`, {
        address: derived.address,
        path: derivationPath,
        index,
      });
    } catch (error) {
      logger.error(`Failed to derive HD wallet for ${chainName}`, {
        path: derivationPath,
        error: getErrorMessage(error),
      });
    }
  }

  return wallets;
}

/**
 * Gets the BIP-44 derivation path for a specific chain.
 * Returns undefined for non-EVM chains.
 */
export function getDerivationPath(chainName: string): string | undefined {
  const index = CHAIN_DERIVATION_INDEX[chainName];
  if (index === undefined) return undefined;
  return `${BIP44_BASE_PATH}/${index}`;
}

/**
 * Validates that a mnemonic is a valid BIP-39 phrase without creating wallets.
 */
export function validateMnemonic(mnemonic: string): boolean {
  try {
    ethers.Mnemonic.fromPhrase(mnemonic);
    return true;
  } catch {
    return false;
  }
}
