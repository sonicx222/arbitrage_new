/**
 * Bridge Router Test Helpers
 *
 * Shared utilities for bridge router tests.
 */

import { jest } from '@jest/globals';
import { ethers } from 'ethers';
import { BRIDGE_DEFAULTS, BridgeQuote } from '../../../src/bridge-router';

/**
 * Create a mock ethers Provider
 */
export function createMockProvider(): jest.Mocked<ethers.Provider> {
  return {
    getBlockNumber: jest.fn(() => Promise.resolve(12345678)),
    getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n, name: 'mainnet' })),
    getBalance: jest.fn(() => Promise.resolve(1000000000000000000n)),
    call: jest.fn(() => Promise.resolve('0x')),
    estimateGas: jest.fn(() => Promise.resolve(200000n)),
    getBlock: jest.fn(() => Promise.resolve(null)),
    getTransaction: jest.fn(() => Promise.resolve(null)),
    getTransactionReceipt: jest.fn(() => Promise.resolve(null)),
    getLogs: jest.fn(() => Promise.resolve([])),
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(() => false),
    listenerCount: jest.fn(() => 0),
    listeners: jest.fn(() => []),
    removeAllListeners: jest.fn(),
  } as unknown as jest.Mocked<ethers.Provider>;
}

/**
 * Create a mock ethers Wallet
 */
export function createMockWallet(provider: ethers.Provider): jest.Mocked<ethers.Wallet> {
  const mockWallet = {
    address: '0x1234567890123456789012345678901234567890',
    provider,
    getAddress: jest.fn(() => Promise.resolve('0x1234567890123456789012345678901234567890')),
    signMessage: jest.fn(() => Promise.resolve('0xsignature')),
    signTransaction: jest.fn(() => Promise.resolve('0xsignedtx')),
    sendTransaction: jest.fn(() => Promise.resolve({
      hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      wait: jest.fn(() => Promise.resolve({
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        status: 1,
        gasUsed: 150000n,
      })),
    })),
    estimateGas: jest.fn(() => Promise.resolve(200000n)),
    connect: jest.fn(),
  } as unknown as jest.Mocked<ethers.Wallet>;
  return mockWallet;
}

/**
 * Create a valid test quote
 */
export function createTestQuote(overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  return {
    protocol: 'stargate',
    sourceChain: 'arbitrum',
    destChain: 'optimism',
    token: 'USDC',
    amountIn: '1000000000', // 1000 USDC (6 decimals)
    amountOut: '997000000', // After 0.06% fee and slippage
    bridgeFee: '600000', // 0.06%
    gasFee: '10000000000000000', // 0.01 ETH
    totalFee: '10000600000',
    estimatedTimeSeconds: 120,
    expiresAt: Date.now() + BRIDGE_DEFAULTS.quoteValidityMs,
    valid: true,
    ...overrides,
  };
}
