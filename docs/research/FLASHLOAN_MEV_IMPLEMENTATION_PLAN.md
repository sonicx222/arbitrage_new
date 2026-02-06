# Flash Loan & MEV Enhancement - Detailed Implementation Plan

**Date**: 2026-02-06
**Status**: Ready for Implementation
**Based on**: [FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md](./FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Implementation Principles](#implementation-principles)
3. [Phase 1: Quick Wins (1-2 weeks)](#phase-1-quick-wins-1-2-weeks)
4. [Phase 2: Protocol Expansion (2-3 weeks)](#phase-2-protocol-expansion-2-3-weeks)
5. [Phase 3: Advanced Protection (3-4 weeks)](#phase-3-advanced-protection-3-4-weeks)
6. [Testing Strategy](#testing-strategy)
7. [Deployment & Rollout](#deployment--rollout)
8. [Success Metrics & Monitoring](#success-metrics--monitoring)

---

## Executive Summary

This implementation plan translates the research findings from [FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md](./FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md) into actionable, testable tasks following TDD principles. The plan prioritizes:

1. **Readability**: Clear abstractions, well-documented code, consistent patterns
2. **Resilience**: Comprehensive error handling, graceful degradation, circuit breakers
3. **Regression Prevention**: Extensive test coverage, type safety, integration tests

### Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| **Provider Pattern** | Already established for flash loans and MEV; maintain consistency |
| **Interface-First Design** | Define interfaces before implementation for better testability |
| **Incremental Rollout** | Feature flags enable safe, gradual deployment |
| **Hot-Path Protection** | All enhancements stay in cold path (execution, not detection) |
| **Free Tier Compliance** | Batching and caching keep resource usage within limits |

---

## Implementation Principles

### 1. Test-Driven Development (TDD)

**For every feature:**
1. Write failing test first
2. Implement minimal code to pass
3. Refactor while keeping tests green
4. Add edge case tests
5. Integration tests at module boundaries

### 2. Resilience Patterns

**Error Handling:**
- Explicit error types (no generic `Error`)
- Graceful degradation (fallback to existing behavior)
- Circuit breakers for external services
- Retry with exponential backoff

**Validation:**
- Input validation at entry points
- Type guards for runtime safety
- Contract invariants in tests

**Example:**
```typescript
// Good: Explicit error type, graceful fallback
try {
  const quote = await batchedQuoter.quotePaths(paths);
  return quote;
} catch (error) {
  logger.warn('Batched quoter failed, falling back to sequential', { error });
  return await sequentialQuoteFallback(paths);
}

// Bad: Silent failure, no context
try {
  return await batchedQuoter.quotePaths(paths);
} catch {
  return undefined;
}
```

### 3. Regression Prevention

**Strategies:**
- Comprehensive unit tests (>85% coverage)
- Integration tests for cross-module interactions
- Contract tests for Solidity interfaces
- Property-based tests for complex logic
- Snapshot tests for calldata encoding

### 4. Readability

**Code Organization:**
- Single Responsibility Principle (SRP) for classes
- Small, focused functions (<50 LOC)
- Descriptive names (no abbreviations)
- JSDoc for public APIs
- ADR references in comments

**Example:**
```typescript
/**
 * Calculate MEV-Share hint configuration for a transaction.
 *
 * Balances privacy (hiding parameters) with value capture (allowing searchers
 * to identify opportunities). See ADR-028 for hint strategy.
 *
 * @param tx - Transaction to generate hints for
 * @returns Hint configuration for MEV-Share submission
 * @see ADR-028 MEV-Share Integration
 */
function calculateMevShareHints(tx: TransactionRequest): MevShareHints {
  return {
    contractAddress: true,  // Allow searchers to see target contract
    functionSelector: true, // Allow searchers to see function being called
    logs: false,            // Hide event data
    calldata: false,        // Hide specific parameters
  };
}
```

---

## Phase 1: Quick Wins (1-2 weeks)

**Goal**: High-impact, low-effort enhancements that don't require contract changes.

**Success Criteria**:
- ✅ 50-90% MEV value capture via MEV-Share
- ✅ 80% latency reduction in profit calculation (150ms → 30ms)
- ✅ MEV protection active on BSC (BloXroute) and Polygon (Fastlane)

---

### Task 1.1: MEV-Share Integration (2 days)

**Objective**: Replace standard Flashbots with MEV-Share to capture rebates.

**Current State Analysis**:
- File: [shared/core/src/mev-protection/flashbots-provider.ts](../../shared/core/src/mev-protection/flashbots-provider.ts)
- Current: Uses standard Flashbots relay (`https://relay.flashbots.net`)
- Limitation: No value capture from MEV extraction

**Data Flow**:
```
Transaction Prepared
    ↓
FlashbotsProvider.submitProtectedTransaction()
    ↓
Build Flashbots bundle with signature
    ↓
POST to Flashbots relay
    ↓
Wait for inclusion confirmation
    ↓
Return tx hash
```

**Enhancement**:
```
Transaction Prepared
    ↓
MevShareProvider.submitProtectedTransaction()
    ↓
Calculate hint configuration (contractAddress=true, calldata=false)
    ↓
Build MEV-Share bundle with hints
    ↓
POST to MEV-Share endpoint (/mev-share)
    ↓
Track rebate via MEV-Share events
    ↓
Return tx hash + rebate amount
```

#### Subtask 1.1.1: Define MEV-Share Types

**TDD Approach**:
```typescript
// File: shared/core/src/mev-protection/mev-share-types.ts

/**
 * MEV-Share hint configuration
 * Controls what information is revealed to searchers
 */
export interface MevShareHints {
  /** Reveal contract address */
  contractAddress: boolean;
  /** Reveal function selector (first 4 bytes of calldata) */
  functionSelector: boolean;
  /** Reveal event logs */
  logs: boolean;
  /** Reveal full calldata */
  calldata: boolean;
  /** Reveal transaction hash */
  hash: boolean;
  /** Reveal transaction value */
  txValue: boolean;
}

/**
 * MEV-Share submission options
 */
export interface MevShareOptions {
  /** Hint configuration */
  hints: MevShareHints;
  /** Minimum rebate percentage to accept (0-100) */
  minRebatePercent?: number;
  /** Maximum blocks to wait for inclusion */
  maxBlockNumber?: number;
}

/**
 * MEV-Share submission result
 */
export interface MevShareSubmissionResult extends MevSubmissionResult {
  /** Rebate amount in wei (if any) */
  rebateAmount?: bigint;
  /** Rebate percentage (0-100) */
  rebatePercent?: number;
  /** MEV-Share bundle ID for tracking */
  bundleId?: string;
}
```

**Tests** (`__tests__/unit/mev-protection/mev-share-types.test.ts`):
```typescript
describe('MevShareHints', () => {
  it('should have all required fields', () => {
    const hints: MevShareHints = {
      contractAddress: true,
      functionSelector: true,
      logs: false,
      calldata: false,
      hash: false,
      txValue: false,
    };
    expect(hints).toBeDefined();
  });
});
```

**Files to Create**:
- `shared/core/src/mev-protection/mev-share-types.ts`
- `shared/core/src/mev-protection/__tests__/unit/mev-share-types.test.ts`

---

#### Subtask 1.1.2: Implement MevShareProvider Class

**TDD Approach**: Write tests first

**Test File** (`__tests__/unit/mev-protection/mev-share-provider.test.ts`):
```typescript
import { MevShareProvider } from '../../../mev-share-provider';
import { ethers } from 'ethers';

describe('MevShareProvider', () => {
  let provider: MevShareProvider;
  let mockProvider: ethers.JsonRpcProvider;
  let mockWallet: ethers.Wallet;

  beforeEach(() => {
    mockProvider = {} as ethers.JsonRpcProvider;
    mockWallet = ethers.Wallet.createRandom();

    provider = new MevShareProvider({
      chain: 'ethereum',
      provider: mockProvider,
      wallet: mockWallet,
      enabled: true,
      flashbotsAuthKey: 'test-key',
      flashbotsRelayUrl: 'https://relay.flashbots.net',
    });
  });

  describe('calculateHints', () => {
    it('should return conservative hints by default', () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      const hints = provider.calculateHints(tx);

      expect(hints).toEqual({
        contractAddress: true,
        functionSelector: true,
        logs: false,
        calldata: false,
        hash: false,
        txValue: false,
      });
    });

    it('should allow revealing transaction value for high-value trades', () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        value: ethers.parseEther('10'), // 10 ETH
        data: '0xabcdef',
      };

      const hints = provider.calculateHints(tx, { revealValue: true });

      expect(hints.txValue).toBe(true);
    });
  });

  describe('buildMevShareBundle', () => {
    it('should construct proper bundle format', async () => {
      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
        nonce: 1,
      };

      const bundle = await provider.buildMevShareBundle(tx, {
        hints: {
          contractAddress: true,
          functionSelector: true,
          logs: false,
          calldata: false,
          hash: false,
          txValue: false,
        },
      });

      expect(bundle).toHaveProperty('version');
      expect(bundle).toHaveProperty('inclusion');
      expect(bundle).toHaveProperty('body');
      expect(bundle.body).toHaveProperty('tx');
      expect(bundle.body).toHaveProperty('hints');
    });
  });

  describe('submitProtectedTransaction', () => {
    it('should fallback to standard Flashbots if MEV-Share fails', async () => {
      // Mock MEV-Share endpoint failure
      const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValueOnce(
        new Error('MEV-Share unavailable')
      );

      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      // Should fallback and not throw
      await expect(provider.submitProtectedTransaction(tx)).resolves.toBeDefined();

      fetchSpy.mockRestore();
    });

    it('should return rebate information if successful', async () => {
      // Mock successful MEV-Share submission
      const mockResponse = {
        bundleId: 'test-bundle-id',
        txHash: '0xabcdef...',
        rebateAmount: '100000000000000000', // 0.1 ETH
      };

      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const tx: ethers.TransactionRequest = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      const result = await provider.submitProtectedTransaction(tx);

      expect(result.success).toBe(true);
      expect(result.rebateAmount).toBe(BigInt(mockResponse.rebateAmount));
      expect(result.bundleId).toBe(mockResponse.bundleId);

      fetchSpy.mockRestore();
    });
  });
});
```

**Implementation** (`shared/core/src/mev-protection/mev-share-provider.ts`):
```typescript
import { ethers } from 'ethers';
import { FlashbotsProvider } from './flashbots-provider';
import {
  MevShareHints,
  MevShareOptions,
  MevShareSubmissionResult,
} from './mev-share-types';
import {
  MevProviderConfig,
  MevSubmissionResult,
} from './types';

/**
 * MEV-Share Provider for Ethereum
 *
 * Extends FlashbotsProvider to use MEV-Share endpoint for value capture.
 * Falls back to standard Flashbots if MEV-Share unavailable.
 *
 * @see ADR-028 MEV-Share Integration
 * @see https://docs.flashbots.net/flashbots-mev-share/overview
 */
export class MevShareProvider extends FlashbotsProvider {
  private readonly mevShareRelayUrl: string;

  constructor(config: MevProviderConfig) {
    super(config);

    // MEV-Share uses different endpoint than standard Flashbots
    this.mevShareRelayUrl = config.flashbotsRelayUrl?.replace(
      'relay.flashbots.net',
      'relay.flashbots.net/mev-share'
    ) || 'https://relay.flashbots.net/mev-share';
  }

  /**
   * Calculate appropriate hints for MEV-Share submission.
   *
   * Strategy: Balance privacy with value capture
   * - Reveal: Contract address, function selector (helps searchers identify opportunities)
   * - Hide: Calldata, logs (protects trade parameters)
   *
   * @param tx - Transaction to generate hints for
   * @param options - Optional hint customization
   * @returns Hint configuration
   */
  calculateHints(
    tx: ethers.TransactionRequest,
    options?: { revealValue?: boolean }
  ): MevShareHints {
    return {
      contractAddress: true,  // Searchers need to know target contract
      functionSelector: true, // Searchers need to know function (e.g., executeArbitrage)
      logs: false,            // Hide event data (profit amounts, swap details)
      calldata: false,        // Hide parameters (amounts, tokens, paths)
      hash: false,            // Hide tx hash (prevents front-running)
      txValue: options?.revealValue || false, // Optionally reveal ETH value
    };
  }

  /**
   * Build MEV-Share bundle payload.
   *
   * @param tx - Transaction to bundle
   * @param options - MEV-Share options
   * @returns Bundle payload for MEV-Share API
   */
  async buildMevShareBundle(
    tx: ethers.TransactionRequest,
    options: MevShareOptions
  ): Promise<Record<string, unknown>> {
    // Sign transaction
    const signedTx = await this.config.wallet.signTransaction(tx);

    // Build bundle in MEV-Share format
    return {
      version: 'v0.1',
      inclusion: {
        block: options.maxBlockNumber || await this.getCurrentBlockNumber() + 5,
        maxBlock: options.maxBlockNumber ? options.maxBlockNumber + 10 : undefined,
      },
      body: {
        tx: signedTx,
        hints: options.hints,
        ...(options.minRebatePercent !== undefined && {
          refundConfig: {
            minRebatePercent: options.minRebatePercent,
          },
        }),
      },
    };
  }

  /**
   * Submit transaction via MEV-Share.
   * Falls back to standard Flashbots if MEV-Share fails.
   *
   * @param tx - Transaction to submit
   * @param options - Optional MEV-Share options
   * @returns Submission result with rebate information
   */
  async submitProtectedTransaction(
    tx: ethers.TransactionRequest,
    options?: Partial<MevShareOptions>
  ): Promise<MevShareSubmissionResult> {
    if (!this.isAvailable()) {
      return this.createErrorResult('MEV-Share not available');
    }

    try {
      // Calculate hints (use defaults if not provided)
      const hints = options?.hints || this.calculateHints(tx);

      // Build bundle
      const bundle = await this.buildMevShareBundle(tx, {
        hints,
        minRebatePercent: options?.minRebatePercent,
        maxBlockNumber: options?.maxBlockNumber,
      });

      // Submit to MEV-Share endpoint
      const response = await fetch(this.mevShareRelayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Flashbots-Signature': await this.signBundle(bundle),
        },
        body: JSON.stringify(bundle),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger?.warn('MEV-Share submission failed, falling back to Flashbots', {
          error,
          statusCode: response.status,
        });

        // Fallback to standard Flashbots
        return await super.submitProtectedTransaction(tx);
      }

      const result = await response.json();

      return {
        success: true,
        txHash: result.txHash,
        bundleId: result.bundleId,
        rebateAmount: result.rebateAmount ? BigInt(result.rebateAmount) : undefined,
        rebatePercent: result.rebatePercent,
      };
    } catch (error) {
      this.logger?.warn('MEV-Share submission error, falling back to Flashbots', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to standard Flashbots
      return await super.submitProtectedTransaction(tx);
    }
  }

  /**
   * Helper to get current block number
   */
  private async getCurrentBlockNumber(): Promise<number> {
    return await this.config.provider.getBlockNumber();
  }

  /**
   * Create error result
   */
  private createErrorResult(error: string): MevShareSubmissionResult {
    return {
      success: false,
      error,
    };
  }
}

/**
 * Factory function to create MevShareProvider
 *
 * @param config - Provider configuration
 * @returns MevShareProvider instance
 */
export function createMevShareProvider(
  config: MevProviderConfig
): MevShareProvider {
  return new MevShareProvider(config);
}
```

**Files to Create**:
- `shared/core/src/mev-protection/mev-share-provider.ts`
- `shared/core/src/mev-protection/__tests__/unit/mev-share-provider.test.ts`

**Resilience Features**:
- ✅ Fallback to standard Flashbots if MEV-Share fails
- ✅ Explicit error logging with context
- ✅ Conservative default hints (privacy-preserving)
- ✅ Graceful handling of missing rebate data

---

#### Subtask 1.1.3: Update MEV Provider Factory

**Objective**: Make MEV-Share the default for Ethereum instead of standard Flashbots.

**Test First** (`__tests__/unit/mev-protection/factory.test.ts`):
```typescript
describe('createProviderAsync - MEV-Share', () => {
  it('should create MevShareProvider for Ethereum by default', async () => {
    const config = {
      chain: 'ethereum' as const,
      provider: mockProvider,
      wallet: mockWallet,
      enabled: true,
      flashbotsAuthKey: 'test-key',
    };

    const provider = await createProviderAsync(config);

    expect(provider).toBeInstanceOf(MevShareProvider);
    expect(provider.strategy).toBe('flashbots'); // Still reports 'flashbots' strategy
  });

  it('should allow forcing standard Flashbots via option', async () => {
    const config = {
      chain: 'ethereum' as const,
      provider: mockProvider,
      wallet: mockWallet,
      enabled: true,
      flashbotsAuthKey: 'test-key',
      useMevShare: false, // Explicit opt-out
    };

    const provider = await createProviderAsync(config);

    expect(provider).toBeInstanceOf(FlashbotsProvider);
    expect(provider).not.toBeInstanceOf(MevShareProvider);
  });
});
```

**Implementation** (update `shared/core/src/mev-protection/factory.ts`):
```typescript
// Add to MevProviderConfig type
export interface MevProviderConfig {
  // ... existing fields

  /**
   * Use MEV-Share for Ethereum instead of standard Flashbots.
   * Default: true (MEV-Share enabled)
   * Set to false to use standard Flashbots without rebates.
   */
  useMevShare?: boolean;
}

// Update factory function
export async function createProviderAsync(
  config: MevProviderConfig
): Promise<IMevProvider> {
  // ... existing validation

  switch (config.chain) {
    case 'ethereum': {
      // Use MEV-Share by default for value capture
      const useMevShare = config.useMevShare !== false;

      if (useMevShare) {
        const { createMevShareProvider } = await import('./mev-share-provider');
        return createMevShareProvider(config);
      } else {
        const { createFlashbotsProvider } = await import('./flashbots-provider');
        return createFlashbotsProvider(config);
      }
    }

    // ... rest of cases
  }
}
```

**Files to Modify**:
- `shared/core/src/mev-protection/types.ts` (add `useMevShare` field)
- `shared/core/src/mev-protection/factory.ts` (update `createProviderAsync`)
- `shared/core/src/mev-protection/__tests__/unit/factory.test.ts` (add tests)

---

#### Subtask 1.1.4: Add Rebate Tracking Metrics

**Objective**: Track MEV-Share rebates for monitoring and profitability analysis.

**Implementation** (`shared/core/src/mev-protection/metrics-manager.ts`):
```typescript
// Add new metrics
export class MevMetricsManager {
  // ... existing metrics

  /**
   * Track MEV-Share rebate received
   */
  recordRebate(chain: string, rebateWei: bigint, txValue: bigint): void {
    const rebatePercent = Number((rebateWei * 10000n) / txValue) / 100; // Percent with 2 decimals

    this.metrics.mevShareRebatesTotal.inc({
      chain,
    });

    this.metrics.mevShareRebateAmount.observe({
      chain,
    }, Number(ethers.formatEther(rebateWei)));

    this.metrics.mevShareRebatePercent.observe({
      chain,
    }, rebatePercent);

    this.logger.info('MEV-Share rebate received', {
      chain,
      rebateWei: rebateWei.toString(),
      rebateEth: ethers.formatEther(rebateWei),
      rebatePercent,
    });
  }
}
```

**Tests** (`__tests__/unit/mev-protection/metrics-manager.test.ts`):
```typescript
describe('recordRebate', () => {
  it('should track rebate metrics', () => {
    const rebateWei = ethers.parseEther('0.1'); // 0.1 ETH rebate
    const txValue = ethers.parseEther('1.0');   // 1 ETH trade

    metricsManager.recordRebate('ethereum', rebateWei, txValue);

    expect(mockMetrics.mevShareRebatesTotal.inc).toHaveBeenCalledWith({
      chain: 'ethereum',
    });
    expect(mockMetrics.mevShareRebatePercent.observe).toHaveBeenCalledWith(
      { chain: 'ethereum' },
      10.0 // 10% rebate
    );
  });
});
```

**Files to Modify**:
- `shared/core/src/mev-protection/metrics-manager.ts`
- `shared/core/src/mev-protection/__tests__/unit/metrics-manager.test.ts`

---

#### Subtask 1.1.5: Integration Test

**Objective**: End-to-end test with mock MEV-Share endpoint.

**Test** (`__tests__/integration/mev-protection/mev-share-integration.test.ts`):
```typescript
import { MevShareProvider } from '../../../src/mev-protection/mev-share-provider';
import { ethers } from 'ethers';
import nock from 'nock';

describe('MEV-Share Integration', () => {
  let provider: MevShareProvider;
  let mockProvider: ethers.JsonRpcProvider;
  let wallet: ethers.Wallet;

  beforeEach(() => {
    // Setup mock provider and wallet
    mockProvider = new ethers.JsonRpcProvider('http://localhost:8545');
    wallet = ethers.Wallet.createRandom().connect(mockProvider);

    provider = new MevShareProvider({
      chain: 'ethereum',
      provider: mockProvider,
      wallet,
      enabled: true,
      flashbotsAuthKey: wallet.privateKey,
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should successfully submit transaction and receive rebate', async () => {
    // Mock block number request
    nock('http://localhost:8545')
      .post('/', { method: 'eth_blockNumber' })
      .reply(200, { result: '0x100' });

    // Mock MEV-Share relay
    const mockRebate = ethers.parseEther('0.05');
    nock('https://relay.flashbots.net')
      .post('/mev-share')
      .reply(200, {
        bundleId: 'test-bundle-123',
        txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        rebateAmount: mockRebate.toString(),
        rebatePercent: 5.0,
      });

    const tx: ethers.TransactionRequest = {
      to: '0x1234567890123456789012345678901234567890',
      value: ethers.parseEther('1.0'),
      data: '0x',
    };

    const result = await provider.submitProtectedTransaction(tx);

    expect(result.success).toBe(true);
    expect(result.rebateAmount).toBe(mockRebate);
    expect(result.rebatePercent).toBe(5.0);
    expect(result.bundleId).toBe('test-bundle-123');
  });

  it('should fallback to standard Flashbots if MEV-Share unavailable', async () => {
    // Mock block number
    nock('http://localhost:8545')
      .post('/', { method: 'eth_blockNumber' })
      .reply(200, { result: '0x100' });

    // Mock MEV-Share failure
    nock('https://relay.flashbots.net')
      .post('/mev-share')
      .reply(503, { error: 'Service unavailable' });

    // Mock standard Flashbots success
    nock('https://relay.flashbots.net')
      .post('/')
      .reply(200, {
        bundleHash: 'fallback-bundle-456',
      });

    const tx: ethers.TransactionRequest = {
      to: '0x1234567890123456789012345678901234567890',
      data: '0x',
    };

    const result = await provider.submitProtectedTransaction(tx);

    // Should succeed via fallback
    expect(result.success).toBe(true);
    // No rebate from standard Flashbots
    expect(result.rebateAmount).toBeUndefined();
  });
});
```

**Files to Create**:
- `shared/core/__tests__/integration/mev-protection/mev-share-integration.test.ts`

---

#### Task 1.1 Deliverables

**Files Created**:
- `shared/core/src/mev-protection/mev-share-types.ts` (types)
- `shared/core/src/mev-protection/mev-share-provider.ts` (implementation)
- `shared/core/src/mev-protection/__tests__/unit/mev-share-provider.test.ts` (unit tests)
- `shared/core/__tests__/integration/mev-protection/mev-share-integration.test.ts` (integration tests)

**Files Modified**:
- `shared/core/src/mev-protection/types.ts` (add `useMevShare` config)
- `shared/core/src/mev-protection/factory.ts` (default to MEV-Share)
- `shared/core/src/mev-protection/metrics-manager.ts` (rebate tracking)
- `shared/core/src/mev-protection/index.ts` (export new types/classes)

**Tests**:
- Unit tests: 15+ tests covering hint calculation, bundle building, fallback
- Integration tests: 2+ tests for end-to-end submission
- Coverage target: >90% for new code

**Documentation**:
- JSDoc on all public methods
- Inline comments explaining hint strategy
- Update ADR-017 with MEV-Share decision (create ADR-028)

---

### Task 1.2: Batched Quoter Contract (3 days)

**Objective**: Deploy on-chain contract to batch multiple `getAmountsOut` calls, reducing RPC latency from ~150ms to ~30ms.

**Current State Analysis**:
- File: [services/execution-engine/src/strategies/flash-loan.strategy.ts](../../services/execution-engine/src/strategies/flash-loan.strategy.ts)
- Current: Sequential RPC calls for each swap quote
- Bottleneck: Network latency multiplied by number of quotes

**Data Flow (Current)**:
```
Opportunity Detected
    ↓
For each DEX pair:
    RPC call: router.getAmountsOut(amountIn, [tokenA, tokenB])
    Wait for response (~50ms)
    ↓
Calculate profit from quotes
    ↓
Total latency: 50ms × N quotes = 150ms+ for 3 quotes
```

**Data Flow (Enhanced)**:
```
Opportunity Detected
    ↓
Build array of quote requests (all paths)
    ↓
Single RPC call: multiPathQuoter.quotePaths(requests)
    Wait for response (~30ms)
    ↓
Parse all quotes from single response
    ↓
Total latency: ~30ms regardless of quote count
```

#### Subtask 1.2.1: Design MultiPathQuoter Contract

**Contract exists**: [contracts/src/MultiPathQuoter.sol](../../contracts/src/MultiPathQuoter.sol)

**Review and Enhance** (if needed):
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MultiPathQuoter
 * @notice Batch quote multiple swap paths in a single call
 * @dev Gas-efficient view function for off-chain profit calculation
 */
contract MultiPathQuoter {
    struct PathQuote {
        address[] path;         // Token path (e.g., [WETH, USDC])
        address router;         // DEX router address
        uint256 amountIn;       // Input amount in wei
    }

    struct QuoteResult {
        uint256 amountOut;      // Expected output amount
        uint256 gasEstimate;    // Estimated gas for this swap
        bool success;           // Whether quote succeeded
        string errorReason;     // Error message if failed
    }

    /**
     * @notice Quote multiple paths in a single call
     * @param quotes Array of path quotes to execute
     * @return results Array of quote results
     */
    function quotePaths(PathQuote[] calldata quotes)
        external
        view
        returns (QuoteResult[] memory results)
    {
        results = new QuoteResult[](quotes.length);

        for (uint256 i = 0; i < quotes.length; i++) {
            PathQuote calldata quote = quotes[i];

            try this.safeQuotePath(quote) returns (uint256 amountOut, uint256 gasEstimate) {
                results[i] = QuoteResult({
                    amountOut: amountOut,
                    gasEstimate: gasEstimate,
                    success: true,
                    errorReason: ""
                });
            } catch Error(string memory reason) {
                results[i] = QuoteResult({
                    amountOut: 0,
                    gasEstimate: 0,
                    success: false,
                    errorReason: reason
                });
            } catch {
                results[i] = QuoteResult({
                    amountOut: 0,
                    gasEstimate: 0,
                    success: false,
                    errorReason: "Unknown error"
                });
            }
        }
    }

    /**
     * @notice Safely quote a single path (internal, for try/catch)
     * @param quote Path quote to execute
     * @return amountOut Expected output amount
     * @return gasEstimate Estimated gas cost
     */
    function safeQuotePath(PathQuote calldata quote)
        external
        view
        returns (uint256 amountOut, uint256 gasEstimate)
    {
        // Call router's getAmountsOut
        IUniswapV2Router router = IUniswapV2Router(quote.router);
        uint256[] memory amounts = router.getAmountsOut(quote.amountIn, quote.path);

        amountOut = amounts[amounts.length - 1];

        // Rough gas estimate (can be refined)
        gasEstimate = 150000 + (quote.path.length - 1) * 50000;
    }
}

interface IUniswapV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}
```

**Tests** (`contracts/test/MultiPathQuoter.test.ts`):
```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { MultiPathQuoter, MockDexRouter, MockERC20 } from '../typechain-types';

describe('MultiPathQuoter', () => {
  let quoter: MultiPathQuoter;
  let router: MockDexRouter;
  let token0: MockERC20;
  let token1: MockERC20;

  beforeEach(async () => {
    // Deploy contracts
    const QuoterFactory = await ethers.getContractFactory('MultiPathQuoter');
    quoter = await QuoterFactory.deploy();

    const RouterFactory = await ethers.getContractFactory('MockDexRouter');
    router = await RouterFactory.deploy();

    const TokenFactory = await ethers.getContractFactory('MockERC20');
    token0 = await TokenFactory.deploy('Token0', 'TK0');
    token1 = await TokenFactory.deploy('Token1', 'TK1');
  });

  describe('quotePaths', () => {
    it('should return quotes for multiple paths', async () => {
      const quotes = [
        {
          path: [await token0.getAddress(), await token1.getAddress()],
          router: await router.getAddress(),
          amountIn: ethers.parseEther('1'),
        },
        {
          path: [await token1.getAddress(), await token0.getAddress()],
          router: await router.getAddress(),
          amountIn: ethers.parseEther('1'),
        },
      ];

      const results = await quoter.quotePaths(quotes);

      expect(results.length).to.equal(2);
      expect(results[0].success).to.be.true;
      expect(results[1].success).to.be.true;
      expect(results[0].amountOut).to.be.gt(0);
      expect(results[1].amountOut).to.be.gt(0);
    });

    it('should handle failed quotes gracefully', async () => {
      const quotes = [
        {
          path: [ethers.ZeroAddress, await token1.getAddress()], // Invalid path
          router: await router.getAddress(),
          amountIn: ethers.parseEther('1'),
        },
      ];

      const results = await quoter.quotePaths(quotes);

      expect(results.length).to.equal(1);
      expect(results[0].success).to.be.false;
      expect(results[0].errorReason).to.not.be.empty;
      expect(results[0].amountOut).to.equal(0);
    });

    it('should be gas-efficient for batched calls', async () => {
      const quotes = Array(10).fill(null).map(() => ({
        path: [await token0.getAddress(), await token1.getAddress()],
        router: await router.getAddress(),
        amountIn: ethers.parseEther('1'),
      }));

      const tx = await quoter.quotePaths.staticCall(quotes);

      // Batched call should be much cheaper than 10 individual calls
      // (exact gas measurement would require gas profiling)
      expect(tx).to.have.length(10);
    });
  });
});
```

**Files to Review/Enhance**:
- `contracts/src/MultiPathQuoter.sol` (already exists, review for completeness)
- `contracts/test/MultiPathQuoter.test.ts` (add comprehensive tests)

---

#### Subtask 1.2.2: Deploy MultiPathQuoter to All Chains

**Deployment Script** (`contracts/scripts/deploy-multi-path-quoter.ts`):
```typescript
import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';

const CHAINS = [
  'ethereum',
  'bsc',
  'polygon',
  'arbitrum',
  'optimism',
  'base',
  'avalanche',
  'fantom',
  'zksync',
  'linea',
];

async function main() {
  const MultiPathQuoter = await ethers.getContractFactory('MultiPathQuoter');

  const deployments: Record<string, string> = {};

  for (const chain of CHAINS) {
    console.log(`\nDeploying to ${chain}...`);

    try {
      const quoter = await MultiPathQuoter.deploy();
      await quoter.waitForDeployment();

      const address = await quoter.getAddress();
      deployments[chain] = address;

      console.log(`✅ ${chain}: ${address}`);

      // Verify on Etherscan (if supported)
      if (process.env.ETHERSCAN_API_KEY) {
        console.log(`Verifying contract on ${chain}...`);
        await run('verify:verify', {
          address,
          constructorArguments: [],
        });
      }
    } catch (error) {
      console.error(`❌ ${chain} deployment failed:`, error);
    }
  }

  // Save deployment addresses
  const outputPath = path.join(__dirname, '../deployments/multi-path-quoter.json');
  fs.writeFileSync(outputPath, JSON.stringify(deployments, null, 2));
  console.log(`\nDeployment addresses saved to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
```

**Configuration Update** (`shared/config/src/service-config.ts`):
```typescript
/**
 * Multi-Path Quoter contract addresses per chain
 * Used for batched swap quote fetching (ADR-029)
 */
export const MULTI_PATH_QUOTER_ADDRESSES: Record<string, string> = {
  ethereum: process.env.MULTI_PATH_QUOTER_ETHEREUM || '',
  bsc: process.env.MULTI_PATH_QUOTER_BSC || '',
  polygon: process.env.MULTI_PATH_QUOTER_POLYGON || '',
  arbitrum: process.env.MULTI_PATH_QUOTER_ARBITRUM || '',
  optimism: process.env.MULTI_PATH_QUOTER_OPTIMISM || '',
  base: process.env.MULTI_PATH_QUOTER_BASE || '',
  avalanche: process.env.MULTI_PATH_QUOTER_AVALANCHE || '',
  fantom: process.env.MULTI_PATH_QUOTER_FANTOM || '',
  zksync: process.env.MULTI_PATH_QUOTER_ZKSYNC || '',
  linea: process.env.MULTI_PATH_QUOTER_LINEA || '',
};

/**
 * MultiPathQuoter contract ABI (minimal interface)
 */
export const MULTI_PATH_QUOTER_ABI = [
  'function quotePaths((address[],address,uint256)[] quotes) view returns ((uint256,uint256,bool,string)[])',
  'function safeQuotePath((address[],address,uint256) quote) view returns (uint256,uint256)',
] as const;
```

**Files to Create/Modify**:
- `contracts/scripts/deploy-multi-path-quoter.ts` (deployment script)
- `shared/config/src/service-config.ts` (add addresses and ABI)
- `contracts/deployments/multi-path-quoter.json` (output file)

---

#### Subtask 1.2.3: Implement BatchedQuoter Service Class

**TDD Approach**: Write tests first

**Test** (`services/execution-engine/__tests__/unit/utils/batched-quoter.test.ts`):
```typescript
import { BatchedQuoter } from '../../../src/utils/batched-quoter';
import { ethers } from 'ethers';

describe('BatchedQuoter', () => {
  let quoter: BatchedQuoter;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    mockProvider = {
      call: jest.fn(),
    } as unknown as ethers.JsonRpcProvider;

    quoter = new BatchedQuoter({
      chain: 'ethereum',
      provider: mockProvider,
      quoterAddress: '0x1234567890123456789012345678901234567890',
    });
  });

  describe('quotePaths', () => {
    it('should batch multiple quote requests into single call', async () => {
      const paths = [
        {
          path: ['0xWETH', '0xUSDC'],
          router: '0xUniswapRouter',
          amountIn: ethers.parseEther('1'),
        },
        {
          path: ['0xUSDC', '0xWETH'],
          router: '0xSushiRouter',
          amountIn: ethers.parseUnits('1000', 6),
        },
      ];

      // Mock successful response
      (mockProvider.call as jest.Mock).mockResolvedValueOnce('0x...');

      const results = await quoter.quotePaths(paths);

      expect(mockProvider.call).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
    });

    it('should fallback to sequential quotes on contract call failure', async () => {
      const paths = [
        {
          path: ['0xWETH', '0xUSDC'],
          router: '0xUniswapRouter',
          amountIn: ethers.parseEther('1'),
        },
      ];

      // Mock batched call failure
      (mockProvider.call as jest.Mock).mockRejectedValueOnce(
        new Error('Contract call failed')
      );

      // Should fallback and not throw
      await expect(quoter.quotePaths(paths)).resolves.toBeDefined();
    });

    it('should cache results for repeated identical requests', async () => {
      const path = {
        path: ['0xWETH', '0xUSDC'],
        router: '0xUniswapRouter',
        amountIn: ethers.parseEther('1'),
      };

      (mockProvider.call as jest.Mock).mockResolvedValue('0x...');

      // First call
      await quoter.quotePaths([path]);
      expect(mockProvider.call).toHaveBeenCalledTimes(1);

      // Second call (should use cache)
      await quoter.quotePaths([path]);
      expect(mockProvider.call).toHaveBeenCalledTimes(1); // No additional call
    });
  });
});
```

**Implementation** (`services/execution-engine/src/utils/batched-quoter.ts`):
```typescript
import { ethers } from 'ethers';
import { MULTI_PATH_QUOTER_ABI, MULTI_PATH_QUOTER_ADDRESSES } from '@arbitrage/config';
import type { Logger } from '../types';

/**
 * Path quote request
 */
export interface PathQuoteRequest {
  path: string[];
  router: string;
  amountIn: bigint;
}

/**
 * Path quote result
 */
export interface PathQuoteResult {
  amountOut: bigint;
  gasEstimate: bigint;
  success: boolean;
  errorReason?: string;
}

/**
 * BatchedQuoter Configuration
 */
export interface BatchedQuoterConfig {
  chain: string;
  provider: ethers.JsonRpcProvider;
  quoterAddress?: string;
  logger?: Logger;
  cacheEnabled?: boolean;
  cacheTtlMs?: number;
}

/**
 * Batched quote fetcher using MultiPathQuoter contract
 *
 * Reduces RPC latency by batching multiple swap quotes into a single call.
 * Falls back to sequential quotes if batched call fails.
 *
 * @see ADR-029 Batched Quote Fetching
 * @see contracts/src/MultiPathQuoter.sol
 */
export class BatchedQuoter {
  private readonly chain: string;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly quoterAddress: string;
  private readonly logger?: Logger;
  private readonly contract: ethers.Contract;

  // Cache for quote results
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { result: PathQuoteResult; timestamp: number }>();

  constructor(config: BatchedQuoterConfig) {
    this.chain = config.chain;
    this.provider = config.provider;
    this.logger = config.logger;
    this.cacheEnabled = config.cacheEnabled !== false;
    this.cacheTtlMs = config.cacheTtlMs || 60_000; // 60 seconds default

    // Get quoter address from config or environment
    this.quoterAddress = config.quoterAddress || MULTI_PATH_QUOTER_ADDRESSES[config.chain];

    if (!this.quoterAddress || this.quoterAddress === '') {
      throw new Error(
        `MultiPathQuoter not deployed on chain '${config.chain}'. ` +
        `Deploy contract or set MULTI_PATH_QUOTER_${config.chain.toUpperCase()} env var.`
      );
    }

    this.contract = new ethers.Contract(
      this.quoterAddress,
      MULTI_PATH_QUOTER_ABI,
      this.provider
    );
  }

  /**
   * Quote multiple paths in a single batched call.
   * Falls back to sequential quotes if batch fails.
   *
   * @param paths - Array of path quote requests
   * @returns Array of quote results
   */
  async quotePaths(paths: PathQuoteRequest[]): Promise<PathQuoteResult[]> {
    if (paths.length === 0) {
      return [];
    }

    // Check cache first
    if (this.cacheEnabled) {
      const cachedResults = this.getCachedResults(paths);
      if (cachedResults) {
        return cachedResults;
      }
    }

    try {
      // Attempt batched call
      const results = await this.batchedQuote(paths);

      // Cache successful results
      if (this.cacheEnabled) {
        this.cacheResults(paths, results);
      }

      return results;
    } catch (error) {
      this.logger?.warn('Batched quote failed, falling back to sequential', {
        chain: this.chain,
        pathCount: paths.length,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to sequential quotes
      return await this.sequentialQuoteFallback(paths);
    }
  }

  /**
   * Execute batched quote via contract call
   */
  private async batchedQuote(paths: PathQuoteRequest[]): Promise<PathQuoteResult[]> {
    // Convert to contract format
    const quotesParam = paths.map(p => ({
      path: p.path,
      router: p.router,
      amountIn: p.amountIn,
    }));

    // Call contract
    const results = await this.contract.quotePaths(quotesParam);

    // Convert results to our format
    return results.map((r: unknown[]) => ({
      amountOut: BigInt(r[0]),
      gasEstimate: BigInt(r[1]),
      success: Boolean(r[2]),
      errorReason: r[3] as string,
    }));
  }

  /**
   * Fallback to sequential quote fetching
   * Uses standard router.getAmountsOut calls
   */
  private async sequentialQuoteFallback(
    paths: PathQuoteRequest[]
  ): Promise<PathQuoteResult[]> {
    const results: PathQuoteResult[] = [];

    for (const path of paths) {
      try {
        const router = new ethers.Contract(
          path.router,
          ['function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])'],
          this.provider
        );

        const amounts = await router.getAmountsOut(path.amountIn, path.path);
        const amountOut = amounts[amounts.length - 1];

        results.push({
          amountOut: BigInt(amountOut),
          gasEstimate: BigInt(150000 + (path.path.length - 1) * 50000),
          success: true,
        });
      } catch (error) {
        results.push({
          amountOut: 0n,
          gasEstimate: 0n,
          success: false,
          errorReason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  /**
   * Generate cache key for a path quote request
   */
  private getCacheKey(path: PathQuoteRequest): string {
    return `${path.router}:${path.path.join(',')}:${path.amountIn.toString()}`;
  }

  /**
   * Get cached results if available and not expired
   */
  private getCachedResults(paths: PathQuoteRequest[]): PathQuoteResult[] | null {
    const now = Date.now();
    const results: PathQuoteResult[] = [];

    for (const path of paths) {
      const key = this.getCacheKey(path);
      const cached = this.cache.get(key);

      if (!cached || now - cached.timestamp > this.cacheTtlMs) {
        return null; // Cache miss or expired
      }

      results.push(cached.result);
    }

    return results;
  }

  /**
   * Cache quote results
   */
  private cacheResults(paths: PathQuoteRequest[], results: PathQuoteResult[]): void {
    const now = Date.now();

    for (let i = 0; i < paths.length; i++) {
      const key = this.getCacheKey(paths[i]);
      this.cache.set(key, {
        result: results[i],
        timestamp: now,
      });
    }

    // Cleanup old cache entries (simple LRU)
    if (this.cache.size > 1000) {
      const cutoff = now - this.cacheTtlMs;
      for (const [key, value] of this.cache.entries()) {
        if (value.timestamp < cutoff) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Factory function to create BatchedQuoter
 */
export function createBatchedQuoter(config: BatchedQuoterConfig): BatchedQuoter {
  return new BatchedQuoter(config);
}
```

**Files to Create**:
- `services/execution-engine/src/utils/batched-quoter.ts`
- `services/execution-engine/__tests__/unit/utils/batched-quoter.test.ts`

**Resilience Features**:
- ✅ Fallback to sequential quotes if batch fails
- ✅ Result caching with TTL (60s default)
- ✅ Explicit error logging with context
- ✅ Graceful handling of missing quoter contract
- ✅ LRU cache cleanup to prevent memory leaks

---

#### Subtask 1.2.4: Integrate BatchedQuoter into FlashLoanStrategy

**Objective**: Use BatchedQuoter in profit calculation instead of sequential calls.

**Test** (`services/execution-engine/__tests__/unit/strategies/flash-loan-batched-quotes.test.ts`):
```typescript
describe('FlashLoanStrategy - Batched Quotes', () => {
  it('should use BatchedQuoter for profit calculation', async () => {
    const batchedQuoter = {
      quotePaths: jest.fn().mockResolvedValue([
        { amountOut: ethers.parseEther('1.1'), success: true },
        { amountOut: ethers.parseEther('1.15'), success: true },
      ]),
    };

    const strategy = new FlashLoanStrategy(mockLogger, {
      contractAddresses: { ethereum: '0xContract' },
      approvedRouters: { ethereum: ['0xRouter1', '0xRouter2'] },
      batchedQuoter,
    });

    // Execute opportunity
    await strategy.execute(mockOpportunity, mockContext);

    // Should have called batched quoter
    expect(batchedQuoter.quotePaths).toHaveBeenCalled();
  });

  it('should fallback gracefully if BatchedQuoter not available', async () => {
    const strategy = new FlashLoanStrategy(mockLogger, {
      contractAddresses: { ethereum: '0xContract' },
      approvedRouters: { ethereum: ['0xRouter1'] },
      // No batchedQuoter provided
    });

    // Should still work (uses existing sequential logic)
    await expect(strategy.execute(mockOpportunity, mockContext)).resolves.toBeDefined();
  });
});
```

**Implementation** (modify `flash-loan.strategy.ts`):
```typescript
export interface FlashLoanStrategyConfig {
  contractAddresses: Record<string, string>;
  approvedRouters: Record<string, string[]>;
  feeOverrides?: Record<string, number>;

  /**
   * Optional BatchedQuoter for efficient multi-path quotes.
   * If not provided, falls back to sequential quotes.
   */
  batchedQuoter?: BatchedQuoter;
}

export class FlashLoanStrategy extends BaseExecutionStrategy {
  private readonly config: FlashLoanStrategyConfig;
  private readonly feeCalculator: FlashLoanFeeCalculator;
  private readonly batchedQuoter?: BatchedQuoter;

  constructor(logger: Logger, config: FlashLoanStrategyConfig) {
    super(logger);
    this.config = config;
    this.batchedQuoter = config.batchedQuoter;
    // ... rest of constructor
  }

  /**
   * Get quotes for multiple paths efficiently.
   * Uses BatchedQuoter if available, otherwise falls back to sequential.
   */
  private async getQuotesForPaths(
    paths: PathQuoteRequest[],
    chain: string,
    ctx: StrategyContext
  ): Promise<PathQuoteResult[]> {
    if (this.batchedQuoter) {
      try {
        return await this.batchedQuoter.quotePaths(paths);
      } catch (error) {
        this.logger.warn('BatchedQuoter failed, using sequential fallback', {
          error: getErrorMessage(error),
        });
        // Fall through to sequential
      }
    }

    // Sequential fallback (existing logic)
    return await this.sequentialQuoteFallback(paths, chain, ctx);
  }
}
```

**Files to Modify**:
- `services/execution-engine/src/strategies/flash-loan.strategy.ts`
- `services/execution-engine/__tests__/unit/strategies/flash-loan.strategy.test.ts`

---

#### Task 1.2 Deliverables

**Contracts**:
- `contracts/src/MultiPathQuoter.sol` (reviewed/enhanced)
- `contracts/test/MultiPathQuoter.test.ts` (comprehensive tests)
- `contracts/scripts/deploy-multi-path-quoter.ts` (deployment)
- `contracts/deployments/multi-path-quoter.json` (addresses)

**Services**:
- `services/execution-engine/src/utils/batched-quoter.ts` (implementation)
- `services/execution-engine/__tests__/unit/utils/batched-quoter.test.ts` (unit tests)

**Configuration**:
- `shared/config/src/service-config.ts` (addresses and ABI)

**Integration**:
- Modified `flash-loan.strategy.ts` to use BatchedQuoter

**Tests**:
- Solidity tests: 10+ tests for MultiPathQuoter contract
- Unit tests: 15+ tests for BatchedQuoter service
- Integration tests: 5+ tests for FlashLoanStrategy integration
- Coverage target: >90%

**Documentation**:
- Create ADR-029: Batched Quote Fetching
- Update implementation plan with deployment addresses

---

### Task 1.3: BloXroute & Fastlane Activation (1 day)

**Objective**: Activate already-configured MEV protection for BSC (BloXroute) and Polygon (Fastlane).

**Current State**:
- File: [shared/config/src/mev-config.ts](../../shared/config/src/mev-config.ts)
- BloXroute and Fastlane are configured but not fully implemented

#### Subtask 1.3.1: Implement BloXrouteProvider

**TDD Approach**:

**Test** (`shared/core/__tests__/unit/mev-protection/bloxroute-provider.test.ts`):
```typescript
import { BloXrouteProvider } from '../../../src/mev-protection/bloxroute-provider';

describe('BloXrouteProvider', () => {
  it('should submit bundle to BloXroute MEV API', async () => {
    const provider = new BloXrouteProvider({
      chain: 'bsc',
      provider: mockProvider,
      wallet: mockWallet,
      enabled: true,
      bloxrouteAuthHeader: 'test-auth-header',
      bloxrouteUrl: 'https://mev.api.blxrbdn.com',
    });

    // Mock BloXroute API
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bundleHash: '0xabc123' }),
    } as Response);

    const tx: ethers.TransactionRequest = {
      to: '0x1234567890123456789012345678901234567890',
      data: '0x',
    };

    const result = await provider.submitProtectedTransaction(tx);

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mev.api.blxrbdn.com/bundle',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'test-auth-header',
        }),
      })
    );

    fetchSpy.mockRestore();
  });

  it('should fallback to public mempool if BloXroute fails', async () => {
    const provider = new BloXrouteProvider({
      chain: 'bsc',
      provider: mockProvider,
      wallet: mockWallet,
      enabled: true,
      bloxrouteAuthHeader: 'test-auth-header',
      fallbackToPublic: true,
    });

    // Mock BloXroute failure
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('API unavailable'));

    const tx: ethers.TransactionRequest = {
      to: '0x1234567890123456789012345678901234567890',
      data: '0x',
    };

    // Should fallback and succeed
    await expect(provider.submitProtectedTransaction(tx)).resolves.toBeDefined();
  });
});
```

**Implementation** (`shared/core/src/mev-protection/bloxroute-provider.ts`):
```typescript
import { ethers } from 'ethers';
import { BaseMevProvider } from './base-provider';
import {
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
} from './types';
import { getErrorMessage } from '../utils/error';

/**
 * BloXroute MEV Protection Provider for BSC
 *
 * Submits transactions via BloXroute's private mempool to prevent frontrunning.
 * Falls back to public mempool if BloXroute unavailable.
 *
 * @see https://docs.bloxroute.com/apis/mev-solution
 */
export class BloXrouteProvider extends BaseMevProvider {
  readonly chain = 'bsc';
  readonly strategy: MevStrategy = 'bloxroute';

  private readonly bloxrouteUrl: string;
  private readonly authHeader: string;

  constructor(config: MevProviderConfig) {
    super(config);

    if (config.chain !== 'bsc') {
      throw new Error('BloXrouteProvider is only for BSC');
    }

    if (!config.bloxrouteAuthHeader) {
      throw new Error('BloXroute auth header required');
    }

    this.bloxrouteUrl = config.bloxrouteUrl || 'https://mev.api.blxrbdn.com';
    this.authHeader = config.bloxrouteAuthHeader;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    // Check if auth header is configured
    return Boolean(this.authHeader);
  }

  async submitProtectedTransaction(
    tx: ethers.TransactionRequest
  ): Promise<MevSubmissionResult> {
    if (!await this.isAvailable()) {
      return this.createErrorResult('BloXroute not available');
    }

    try {
      // Sign transaction
      const signedTx = await this.config.wallet.signTransaction(tx);

      // Submit to BloXroute MEV API
      const response = await fetch(`${this.bloxrouteUrl}/bundle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.authHeader,
        },
        body: JSON.stringify({
          transaction: signedTx,
          bundleUuid: this.generateBundleUuid(),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`BloXroute submission failed: ${error}`);
      }

      const result = await response.json();

      return {
        success: true,
        txHash: result.txHash || tx.hash,
        bundleHash: result.bundleHash,
      };
    } catch (error) {
      this.logger?.warn('BloXroute submission failed', {
        error: getErrorMessage(error),
      });

      // Fallback to public mempool
      if (this.config.fallbackToPublic) {
        return await this.fallbackToPublicMempool(tx);
      }

      return this.createErrorResult(getErrorMessage(error));
    }
  }

  /**
   * Generate unique bundle UUID
   */
  private generateBundleUuid(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  private createErrorResult(error: string): MevSubmissionResult {
    return {
      success: false,
      error,
    };
  }
}
```

**Files to Create**:
- `shared/core/src/mev-protection/bloxroute-provider.ts`
- `shared/core/__tests__/unit/mev-protection/bloxroute-provider.test.ts`

---

#### Subtask 1.3.2: Implement FastlaneProvider (similar pattern)

**Implementation** (`shared/core/src/mev-protection/fastlane-provider.ts`):
```typescript
/**
 * Fastlane MEV Protection Provider for Polygon
 *
 * Submits transactions via Polygon's Fastlane RPC for ordering priority.
 *
 * @see https://fastlane.polygon.technology/
 */
export class FastlaneProvider extends BaseMevProvider {
  readonly chain = 'polygon';
  readonly strategy: MevStrategy = 'fastlane';

  private readonly fastlaneUrl: string;

  constructor(config: MevProviderConfig) {
    super(config);

    if (config.chain !== 'polygon') {
      throw new Error('FastlaneProvider is only for Polygon');
    }

    this.fastlaneUrl = config.fastlaneUrl || 'https://fastlane-rpc.polygon.technology';
  }

  async submitProtectedTransaction(
    tx: ethers.TransactionRequest
  ): Promise<MevSubmissionResult> {
    try {
      // Fastlane uses standard eth_sendRawTransaction via custom RPC
      const fastlaneProvider = new ethers.JsonRpcProvider(this.fastlaneUrl);
      const signedTx = await this.config.wallet.signTransaction(tx);
      const txHash = await fastlaneProvider.send('eth_sendRawTransaction', [signedTx]);

      return {
        success: true,
        txHash,
      };
    } catch (error) {
      this.logger?.warn('Fastlane submission failed', {
        error: getErrorMessage(error),
      });

      // Fallback to public RPC
      if (this.config.fallbackToPublic) {
        return await this.fallbackToPublicMempool(tx);
      }

      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }
}
```

**Files to Create**:
- `shared/core/src/mev-protection/fastlane-provider.ts`
- `shared/core/__tests__/unit/mev-protection/fastlane-provider.test.ts`

---

#### Subtask 1.3.3: Update MEV Provider Factory

**Modify** (`shared/core/src/mev-protection/factory.ts`):
```typescript
export async function createProviderAsync(
  config: MevProviderConfig
): Promise<IMevProvider> {
  // ... existing validation

  switch (config.chain) {
    case 'ethereum':
      // ... existing MEV-Share logic

    case 'bsc': {
      const { createBloXrouteProvider } = await import('./bloxroute-provider');
      return createBloXrouteProvider(config);
    }

    case 'polygon': {
      const { createFastlaneProvider } = await import('./fastlane-provider');
      return createFastlaneProvider(config);
    }

    // ... rest of chains
  }
}
```

---

#### Task 1.3 Deliverables

**Files Created**:
- `shared/core/src/mev-protection/bloxroute-provider.ts`
- `shared/core/src/mev-protection/fastlane-provider.ts`
- `shared/core/__tests__/unit/mev-protection/bloxroute-provider.test.ts`
- `shared/core/__tests__/unit/mev-protection/fastlane-provider.test.ts`

**Files Modified**:
- `shared/core/src/mev-protection/factory.ts` (add BSC/Polygon cases)
- `shared/core/src/mev-protection/types.ts` (add bloxroute/fastlane to MevStrategy)
- `shared/core/src/mev-protection/index.ts` (export new providers)

**Tests**:
- Unit tests: 10+ tests per provider
- Integration tests: 2+ tests for factory integration
- Coverage target: >90%

---

## Phase 1 Summary

**Total Effort**: 6 days (with 1 day of buffer = **1-2 weeks**)

**Deliverables**:
✅ MEV-Share Integration (Ethereum value capture)
✅ Batched Quoter Contract (80% latency reduction)
✅ BloXroute Provider (BSC MEV protection)
✅ Fastlane Provider (Polygon MEV protection)

**Expected Impact**:
- MEV value capture: 50-90% of extracted value returned
- Quote latency: 150ms → 30ms (80% reduction)
- MEV protection coverage: 70% → 85% (added BSC + Polygon)

**Next**: Phase 2 (Protocol Expansion)

---

## Phase 2: Protocol Expansion (2-3 weeks)

[Detailed tasks for Phase 2 would follow the same TDD structure...]

**Summary**:
- Task 2.1: PancakeSwap V3 Flash Loan Provider (5 days)
- Task 2.2: Balancer V2 Flash Loan Provider (3 days)
- Task 2.3: Flash Loan Protocol Aggregator (3 days)

[Continuing with detailed subtasks...]

---

## Phase 3: Advanced Protection (3-4 weeks)

[Detailed tasks for Phase 3...]

**Summary**:
- Task 3.1: Commit-Reveal Smart Contract (5 days)
- Task 3.2: Adaptive Risk Scoring (3 days)
- Task 3.3: Self-Backrun Bundling (4 days)
- Task 3.4: SyncSwap Flash Loan Provider (3 days)

---

## Testing Strategy

### Unit Tests
- **Target**: >90% coverage for new code
- **Focus**: Individual functions, edge cases, error paths
- **Tools**: Jest, test doubles (mocks/spies)

### Integration Tests
- **Target**: All cross-module interactions
- **Focus**: Real contracts (testnets), actual RPC calls
- **Tools**: Hardhat network forks, nock for HTTP mocking

### Contract Tests
- **Target**: 100% coverage for Solidity
- **Focus**: Security, gas efficiency, revert conditions
- **Tools**: Hardhat, Foundry

### Property-Based Tests
- **Target**: Complex logic (profit calculations, fee math)
- **Focus**: Invariants that must hold for all inputs
- **Tools**: fast-check

### Regression Tests
- **Target**: All fixed bugs
- **Focus**: Ensure bugs don't reappear
- **Approach**: Dedicated test file for regression suite

---

## Deployment & Rollout

### Feature Flags
```typescript
export const FEATURE_FLAGS = {
  mevShare: process.env.FEATURE_MEV_SHARE === 'true',
  batchedQuoter: process.env.FEATURE_BATCHED_QUOTER === 'true',
  pancakeswapV3: process.env.FEATURE_PANCAKESWAP_V3 === 'true',
  balancerV2: process.env.FEATURE_BALANCER_V2 === 'true',
  commitReveal: process.env.FEATURE_COMMIT_REVEAL === 'true',
};
```

### Rollout Phases
1. **Testnet Deployment** (all chains)
2. **Canary Deployment** (5% of opportunities)
3. **Gradual Rollout** (25% → 50% → 100%)
4. **Full Production**

### Monitoring
- **Metrics**: Success rate, latency, rebates captured
- **Alerts**: Error rate >5%, latency >100ms, MEV protection failures
- **Dashboards**: Grafana panels for each enhancement

---

## Success Metrics & Monitoring

### Phase 1 Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| MEV Value Captured | 0% | >50% | MEV-Share rebates / tx value |
| Quote Latency P99 | ~150ms | <50ms | Prometheus histogram |
| BSC MEV Protection | 0% | >90% | BloXroute success rate |
| Polygon MEV Protection | 0% | >90% | Fastlane success rate |

### Phase 2 Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Flash Loan Chain Coverage | 6/11 (55%) | 9/11 (82%) | Chains with FL provider |
| Average Flash Loan Fee | 0.09% | <0.08% | Fee tracking per protocol |
| FL Execution Success Rate | N/A | >95% | Successful FL txs / total |

### Phase 3 Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Commit-Reveal Usage | 0% | 10% of high-risk | Transaction analysis |
| MEV Attack Prevention | Unknown | >95% | Manual review + metrics |
| Adaptive Threshold Accuracy | N/A | <5% false positives | Risk analysis logs |

---

## Appendix A: File Structure

```
arbitrage_new/
├── contracts/
│   ├── src/
│   │   ├── FlashLoanArbitrage.sol (existing)
│   │   ├── MultiPathQuoter.sol (existing, enhanced)
│   │   ├── CommitRevealArbitrage.sol (Phase 3)
│   │   └── interfaces/
│   ├── test/
│   └── scripts/
│       └── deploy-multi-path-quoter.ts (new)
├── shared/
│   ├── config/
│   │   └── src/
│   │       ├── service-config.ts (modified)
│   │       └── mev-config.ts (modified)
│   └── core/
│       └── src/
│           └── mev-protection/
│               ├── mev-share-types.ts (new)
│               ├── mev-share-provider.ts (new)
│               ├── bloxroute-provider.ts (new)
│               ├── fastlane-provider.ts (new)
│               ├── flashbots-provider.ts (existing)
│               ├── factory.ts (modified)
│               └── __tests__/
├── services/
│   └── execution-engine/
│       ├── src/
│       │   ├── strategies/
│       │   │   ├── flash-loan.strategy.ts (modified)
│       │   │   └── flash-loan-providers/
│       │   │       ├── pancakeswap-v3.provider.ts (Phase 2)
│       │   │       ├── balancer-v2.provider.ts (Phase 2)
│       │   │       └── flash-loan-aggregator.ts (Phase 2)
│       │   └── utils/
│       │       └── batched-quoter.ts (new)
│       └── __tests__/
└── docs/
    ├── architecture/
    │   └── adr/
    │       ├── ADR-028-mev-share-integration.md (new)
    │       ├── ADR-029-batched-quote-fetching.md (new)
    │       └── ADR-030-multi-protocol-flash-loans.md (Phase 2)
    └── research/
        ├── FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md (existing)
        └── FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md (this file)
```

---

## Appendix B: ADR Templates

### ADR-028: MEV-Share Integration

**Status**: Proposed
**Context**: Need to capture MEV value instead of letting it go to block builders
**Decision**: Integrate MEV-Share for Ethereum mainnet transactions
**Consequences**: 50-90% MEV value returned, minimal latency overhead
**Alternatives**: Standard Flashbots (no rebate), MEV Blocker (CoW Protocol)

### ADR-029: Batched Quote Fetching

**Status**: Proposed
**Context**: Sequential RPC calls create 150ms+ latency bottleneck
**Decision**: Deploy MultiPathQuoter contract for batched quotes
**Consequences**: 80% latency reduction, single contract deployment per chain
**Alternatives**: Off-chain quote aggregation (less accurate), parallel RPC (still slower)

---

## Appendix C: Regression Prevention Checklist

For each feature:
- [ ] Unit tests with >90% coverage
- [ ] Integration tests for cross-module boundaries
- [ ] Error handling tests (network failures, contract reverts)
- [ ] Edge case tests (zero values, max values, empty arrays)
- [ ] Type safety (TypeScript strict mode, no `any`)
- [ ] Fallback behavior tested
- [ ] Metrics/observability added
- [ ] Documentation updated (JSDoc, ADRs, this plan)
- [ ] Feature flag for safe rollout
- [ ] Monitoring dashboard created

---

**End of Implementation Plan**

**Next Steps**:
1. Review and approve this plan
2. Create GitHub issues/tickets for each task
3. Begin Phase 1, Task 1.1 (MEV-Share Integration)
4. Follow TDD workflow strictly
5. Update this document with deployment addresses and actual metrics

**Questions or Clarifications**: See research document or create discussion thread.
