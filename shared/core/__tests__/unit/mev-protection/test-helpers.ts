/**
 * Shared Test Helpers for MEV Provider Integration Tests
 *
 * Reduces duplication across BloXroute, Fastlane, and other provider tests.
 * Provides common mock setup, assertions, and test utilities.
 */

import { ethers } from 'ethers';
import { StandardProvider } from '../../../src/mev-protection/standard-provider';

// =============================================================================
// Mock Setup Helpers
// =============================================================================

export interface MockEthersProvider {
  getBlockNumber: jest.Mock;
  getTransactionCount: jest.Mock;
  getFeeData: jest.Mock;
  estimateGas: jest.Mock;
  getTransactionReceipt: jest.Mock;
}

export interface MockWallet {
  address: string;
  signTransaction: jest.Mock;
  sendTransaction: jest.Mock;
}

/**
 * Create a mock ethers provider with common defaults
 */
export function createMockEthersProvider(overrides?: Partial<MockEthersProvider>): ethers.JsonRpcProvider {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(1000000),
    getTransactionCount: jest.fn().mockResolvedValue(5),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('30', 'gwei'),
      gasPrice: ethers.parseUnits('30', 'gwei'),
    }),
    estimateGas: jest.fn().mockResolvedValue(150000n),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      hash: '0xtxhash',
      blockNumber: 1000001,
      status: 1,
    }),
    ...overrides,
  } as unknown as ethers.JsonRpcProvider;
}

/**
 * Create a mock wallet with common defaults
 */
export function createMockWallet(address?: string): ethers.Wallet {
  return {
    address: address || '0x1234567890123456789012345678901234567890',
    signTransaction: jest.fn().mockResolvedValue('0xsignedtx'),
    sendTransaction: jest.fn().mockResolvedValue({
      hash: '0xpublictxhash',
      wait: jest.fn().mockResolvedValue({
        hash: '0xpublictxhash',
        blockNumber: 1000001,
        status: 1,
      }),
    }),
  } as unknown as ethers.Wallet;
}

/**
 * Create a sample transaction for testing
 */
export function createSampleTransaction(overrides?: Partial<ethers.TransactionRequest>): ethers.TransactionRequest {
  return {
    to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    data: '0x',
    ...overrides,
  };
}

// =============================================================================
// Mock Fetch Helpers
// =============================================================================

/**
 * Mock successful RPC response
 */
export function mockSuccessfulRpcResponse(result: string = '0xtxhash'): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result,
    }),
  });
}

/**
 * Mock RPC error response
 */
export function mockRpcErrorResponse(errorMessage: string = 'Service unavailable'): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      error: { message: errorMessage },
    }),
  });
}

/**
 * Mock network error
 */
export function mockNetworkError(errorMessage: string = 'Network timeout'): jest.Mock {
  return jest.fn().mockRejectedValue(new Error(errorMessage));
}

/**
 * Mock malformed RPC response (missing required fields)
 */
export function mockMalformedRpcResponse(): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      jsonrpc: '2.0',
      // Missing id and result/error
    }),
  });
}

/**
 * Mock health check response
 */
export function mockHealthCheckResponse(blockNumber: number = 1000000): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: `0x${blockNumber.toString(16)}`,
    }),
  });
}

// =============================================================================
// Assertion Helpers
// =============================================================================

/**
 * Assert fetch was called with correct RPC URL and headers
 */
export function assertRpcCall(
  mockFetch: jest.Mock,
  expectedUrl: string,
  expectedHeaders: Record<string, string>,
  expectedMethod: string = 'eth_sendRawTransaction'
): void {
  expect(mockFetch).toHaveBeenCalledWith(
    expectedUrl,
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining(expectedHeaders),
      body: expect.any(String),
    })
  );

  // Verify request body format
  const callArgs = mockFetch.mock.calls[0];
  const requestBody = JSON.parse(callArgs[1].body);
  expect(requestBody).toMatchObject({
    jsonrpc: '2.0',
    id: 1,
    method: expectedMethod,
  });
}

/**
 * Assert successful submission result
 */
export function assertSuccessfulSubmission(
  result: any,
  expectedStrategy: string,
  shouldUseFallback: boolean = false
): void {
  expect(result.success).toBe(true);
  expect(result.strategy).toBe(expectedStrategy);
  expect(result.usedFallback).toBe(shouldUseFallback);
}

/**
 * Assert failed submission result
 */
export function assertFailedSubmission(
  result: any,
  expectedErrorPattern?: string | RegExp
): void {
  expect(result.success).toBe(false);
  if (expectedErrorPattern) {
    if (typeof expectedErrorPattern === 'string') {
      expect(result.error).toContain(expectedErrorPattern);
    } else {
      expect(result.error).toMatch(expectedErrorPattern);
    }
  }
}

/**
 * Assert metrics were updated correctly
 */
export function assertMetricsUpdated(
  provider: StandardProvider,
  expected: {
    totalSubmissions: number;
    successfulSubmissions?: number;
    failedSubmissions?: number;
    fallbackSubmissions?: number;
    providerSpecificSubmissions?: number;
  }
): void {
  const metrics = provider.getMetrics();
  expect(metrics.totalSubmissions).toBe(expected.totalSubmissions);

  if (expected.successfulSubmissions !== undefined) {
    expect(metrics.successfulSubmissions).toBe(expected.successfulSubmissions);
  }

  if (expected.failedSubmissions !== undefined) {
    expect(metrics.failedSubmissions).toBe(expected.failedSubmissions);
  }

  if (expected.fallbackSubmissions !== undefined) {
    expect(metrics.fallbackSubmissions).toBe(expected.fallbackSubmissions);
  }

  if (expected.providerSpecificSubmissions !== undefined) {
    const providerMetric = provider.strategy === 'bloxroute'
      ? metrics.bloxrouteSubmissions
      : metrics.fastlaneSubmissions;
    expect(providerMetric).toBe(expected.providerSpecificSubmissions);
  }
}

// =============================================================================
// Test Scenario Builders
// =============================================================================

/**
 * Run a standard successful submission test
 */
export async function testSuccessfulSubmission(
  provider: StandardProvider,
  mockFetch: jest.Mock,
  expectedUrl: string,
  expectedHeaders: Record<string, string>,
  expectedStrategy: string
): Promise<void> {
  const tx = createSampleTransaction({ value: ethers.parseEther('1.5') });
  const result = await provider.sendProtectedTransaction(tx);

  assertRpcCall(mockFetch, expectedUrl, expectedHeaders);
  assertSuccessfulSubmission(result, expectedStrategy, false);
}

/**
 * Run a standard fallback test
 */
export async function testFallbackOnError(
  provider: StandardProvider,
  wallet: MockWallet
): Promise<void> {
  const tx = createSampleTransaction();
  const result = await provider.sendProtectedTransaction(tx);

  expect(result.success).toBe(true);
  expect(result.usedFallback).toBe(true);
  expect(wallet.sendTransaction).toHaveBeenCalled();
}

/**
 * Run a standard simulation test
 */
export async function testSimulation(
  provider: StandardProvider,
  mockEthersProvider: MockEthersProvider,
  expectedGasUsed: bigint = 150000n
): Promise<void> {
  const tx = createSampleTransaction();
  const simResult = await provider.simulateTransaction(tx);

  expect(simResult.success).toBe(true);
  expect(simResult.gasUsed).toBe(expectedGasUsed);
  expect(mockEthersProvider.estimateGas).toHaveBeenCalled();
}

/**
 * Run a standard simulation failure test
 */
export async function testSimulationFailure(
  provider: StandardProvider,
  mockEthersProvider: MockEthersProvider,
  errorMessage: string = 'execution reverted'
): Promise<void> {
  (mockEthersProvider.estimateGas as jest.Mock).mockRejectedValue(
    new Error(errorMessage)
  );

  const tx = createSampleTransaction();
  const simResult = await provider.simulateTransaction(tx);

  expect(simResult.success).toBe(false);
  expect(simResult.error).toContain(errorMessage);
}

/**
 * Run a standard health check test
 */
export async function testHealthCheck(
  provider: StandardProvider,
  expectedChain: string,
  expectedBlockNumber: number = 1000000
): Promise<void> {
  const health = await provider.healthCheck();

  expect(health.healthy).toBe(true);
  expect(health.message).toContain(expectedChain);
  expect(health.message).toContain('healthy');
}
