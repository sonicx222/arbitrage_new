/**
 * Message Validators Unit Tests
 *
 * Tests for the shared message validation utilities (REF-2).
 *
 * @migrated from shared/core/src/message-validators.test.ts
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect } from '@jest/globals';

// Import from package alias (new pattern per ADR-009)
import {
  validatePriceUpdate,
  validateWhaleTransaction,
  validateSwapEvent,
  validateReserveUpdate,
  validateCoordinatorCommand,
  validateServiceHealthStatus,
  validateMessage,
  validateBatch,
  createPriceUpdate,
  createWhaleTransaction,
  createCoordinatorCommand
} from '@arbitrage/core';

import type {
  PriceUpdate,
  WhaleTransaction,
  SwapEvent,
  ReserveUpdate,
  CoordinatorCommand,
  ServiceHealthStatus
} from '@arbitrage/core';

// =============================================================================
// Test Data
// =============================================================================

const validPriceUpdate: PriceUpdate = {
  chain: 'ethereum',
  dex: 'uniswap_v3',
  pairKey: 'WETH-USDC',
  price: 1850.50,
  timestamp: Date.now(),
  blockNumber: 18000000
};

const validWhaleTransaction: WhaleTransaction = {
  chain: 'ethereum',
  type: 'swap',
  hash: '0x1234567890abcdef',
  from: '0xfrom',
  to: '0xto',
  value: '1000000000000000000',
  timestamp: Date.now()
};

const validSwapEvent: SwapEvent = {
  chain: 'ethereum',
  dex: 'uniswap_v3',
  pairAddress: '0xpair',
  token0: '0xtoken0',
  token1: '0xtoken1',
  amount0In: '1000000',
  amount1In: '0',
  amount0Out: '0',
  amount1Out: '500000',
  sender: '0xsender',
  to: '0xto',
  blockNumber: 18000000,
  transactionHash: '0xhash',
  logIndex: 0,
  timestamp: Date.now()
};

const validReserveUpdate: ReserveUpdate = {
  chain: 'ethereum',
  dex: 'uniswap_v3',
  pairAddress: '0xpair',
  reserve0: '1000000000000000000000',
  reserve1: '2000000000000000000000',
  blockNumber: 18000000,
  timestamp: Date.now()
};

const validCoordinatorCommand: CoordinatorCommand = {
  type: 'start',
  timestamp: Date.now()
};

const validServiceHealthStatus: ServiceHealthStatus = {
  serviceId: 'detector-1',
  serviceName: 'unified-detector',
  status: 'healthy',
  timestamp: Date.now()
};

// =============================================================================
// PriceUpdate Validation Tests
// =============================================================================

describe('validatePriceUpdate()', () => {
  it('should accept valid price update', () => {
    expect(validatePriceUpdate(validPriceUpdate)).toBe(true);
  });

  it('should reject null', () => {
    expect(validatePriceUpdate(null)).toBe(false);
  });

  it('should reject undefined', () => {
    expect(validatePriceUpdate(undefined)).toBe(false);
  });

  it('should reject non-object', () => {
    expect(validatePriceUpdate('string')).toBe(false);
    expect(validatePriceUpdate(123)).toBe(false);
    expect(validatePriceUpdate([])).toBe(false);
  });

  it('should reject missing chain', () => {
    const { chain, ...rest } = validPriceUpdate;
    expect(validatePriceUpdate(rest)).toBe(false);
  });

  it('should reject empty chain', () => {
    expect(validatePriceUpdate({ ...validPriceUpdate, chain: '' })).toBe(false);
  });

  it('should reject missing dex', () => {
    const { dex, ...rest } = validPriceUpdate;
    expect(validatePriceUpdate(rest)).toBe(false);
  });

  it('should reject missing pairKey', () => {
    const { pairKey, ...rest } = validPriceUpdate;
    expect(validatePriceUpdate(rest)).toBe(false);
  });

  it('should reject negative price', () => {
    expect(validatePriceUpdate({ ...validPriceUpdate, price: -1 })).toBe(false);
  });

  it('should reject NaN price', () => {
    expect(validatePriceUpdate({ ...validPriceUpdate, price: NaN })).toBe(false);
  });

  it('should reject zero timestamp', () => {
    expect(validatePriceUpdate({ ...validPriceUpdate, timestamp: 0 })).toBe(false);
  });

  it('should accept optional reserves', () => {
    const withReserves = {
      ...validPriceUpdate,
      reserves: { reserve0: '1000', reserve1: '2000' }
    };
    expect(validatePriceUpdate(withReserves)).toBe(true);
  });

  it('should reject invalid reserves format', () => {
    const invalidReserves = {
      ...validPriceUpdate,
      reserves: { reserve0: 1000, reserve1: 2000 } // numbers instead of strings
    };
    expect(validatePriceUpdate(invalidReserves)).toBe(false);
  });
});

// =============================================================================
// WhaleTransaction Validation Tests
// =============================================================================

describe('validateWhaleTransaction()', () => {
  it('should accept valid whale transaction', () => {
    expect(validateWhaleTransaction(validWhaleTransaction)).toBe(true);
  });

  it('should reject null', () => {
    expect(validateWhaleTransaction(null)).toBe(false);
  });

  it('should reject missing hash', () => {
    const { hash, ...rest } = validWhaleTransaction;
    expect(validateWhaleTransaction(rest)).toBe(false);
  });

  it('should reject empty from address', () => {
    expect(validateWhaleTransaction({ ...validWhaleTransaction, from: '' })).toBe(false);
  });

  it('should reject empty to address', () => {
    expect(validateWhaleTransaction({ ...validWhaleTransaction, to: '' })).toBe(false);
  });

  it('should accept optional token', () => {
    const withToken = { ...validWhaleTransaction, token: '0xtoken' };
    expect(validateWhaleTransaction(withToken)).toBe(true);
  });

  it('should reject invalid token type', () => {
    const invalidToken = { ...validWhaleTransaction, token: 123 };
    expect(validateWhaleTransaction(invalidToken)).toBe(false);
  });
});

// =============================================================================
// SwapEvent Validation Tests
// =============================================================================

describe('validateSwapEvent()', () => {
  it('should accept valid swap event', () => {
    expect(validateSwapEvent(validSwapEvent)).toBe(true);
  });

  it('should reject null', () => {
    expect(validateSwapEvent(null)).toBe(false);
  });

  it('should reject missing pairAddress', () => {
    const { pairAddress, ...rest } = validSwapEvent;
    expect(validateSwapEvent(rest)).toBe(false);
  });

  it('should reject missing transactionHash', () => {
    const { transactionHash, ...rest } = validSwapEvent;
    expect(validateSwapEvent(rest)).toBe(false);
  });

  it('should reject negative blockNumber', () => {
    expect(validateSwapEvent({ ...validSwapEvent, blockNumber: -1 })).toBe(false);
  });

  it('should reject negative logIndex', () => {
    expect(validateSwapEvent({ ...validSwapEvent, logIndex: -1 })).toBe(false);
  });
});

// =============================================================================
// ReserveUpdate Validation Tests
// =============================================================================

describe('validateReserveUpdate()', () => {
  it('should accept valid reserve update', () => {
    expect(validateReserveUpdate(validReserveUpdate)).toBe(true);
  });

  it('should reject null', () => {
    expect(validateReserveUpdate(null)).toBe(false);
  });

  it('should reject missing pairAddress', () => {
    const { pairAddress, ...rest } = validReserveUpdate;
    expect(validateReserveUpdate(rest)).toBe(false);
  });

  it('should reject non-string reserves', () => {
    expect(validateReserveUpdate({ ...validReserveUpdate, reserve0: 1000 })).toBe(false);
    expect(validateReserveUpdate({ ...validReserveUpdate, reserve1: 2000 })).toBe(false);
  });
});

// =============================================================================
// CoordinatorCommand Validation Tests
// =============================================================================

describe('validateCoordinatorCommand()', () => {
  it('should accept valid start command', () => {
    expect(validateCoordinatorCommand({ type: 'start', timestamp: Date.now() })).toBe(true);
  });

  it('should accept valid stop command', () => {
    expect(validateCoordinatorCommand({ type: 'stop', timestamp: Date.now() })).toBe(true);
  });

  it('should accept valid pause command', () => {
    expect(validateCoordinatorCommand({ type: 'pause', timestamp: Date.now() })).toBe(true);
  });

  it('should accept valid resume command', () => {
    expect(validateCoordinatorCommand({ type: 'resume', timestamp: Date.now() })).toBe(true);
  });

  it('should accept valid config_update command', () => {
    expect(validateCoordinatorCommand({
      type: 'config_update',
      timestamp: Date.now(),
      payload: { key: 'value' }
    })).toBe(true);
  });

  it('should reject invalid command type', () => {
    expect(validateCoordinatorCommand({ type: 'invalid', timestamp: Date.now() })).toBe(false);
  });

  it('should reject null', () => {
    expect(validateCoordinatorCommand(null)).toBe(false);
  });

  it('should accept optional target', () => {
    expect(validateCoordinatorCommand({
      type: 'start',
      timestamp: Date.now(),
      target: 'detector-1'
    })).toBe(true);
  });
});

// =============================================================================
// ServiceHealthStatus Validation Tests
// =============================================================================

describe('validateServiceHealthStatus()', () => {
  it('should accept valid healthy status', () => {
    expect(validateServiceHealthStatus({ ...validServiceHealthStatus, status: 'healthy' })).toBe(true);
  });

  it('should accept valid degraded status', () => {
    expect(validateServiceHealthStatus({ ...validServiceHealthStatus, status: 'degraded' })).toBe(true);
  });

  it('should accept valid unhealthy status', () => {
    expect(validateServiceHealthStatus({ ...validServiceHealthStatus, status: 'unhealthy' })).toBe(true);
  });

  it('should reject invalid status', () => {
    expect(validateServiceHealthStatus({ ...validServiceHealthStatus, status: 'unknown' })).toBe(false);
  });

  it('should reject missing serviceId', () => {
    const { serviceId, ...rest } = validServiceHealthStatus;
    expect(validateServiceHealthStatus(rest)).toBe(false);
  });

  it('should accept optional metrics', () => {
    expect(validateServiceHealthStatus({
      ...validServiceHealthStatus,
      metrics: { cpu: 50, memory: 60 }
    })).toBe(true);
  });

  it('should accept optional errors', () => {
    expect(validateServiceHealthStatus({
      ...validServiceHealthStatus,
      errors: ['Error 1', 'Error 2']
    })).toBe(true);
  });
});

// =============================================================================
// Generic Validation Utilities Tests
// =============================================================================

describe('validateMessage()', () => {
  it('should return valid result for valid data', () => {
    const result = validateMessage(validPriceUpdate, validatePriceUpdate, 'PriceUpdate');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(validPriceUpdate);
  });

  it('should return invalid result with errors for null', () => {
    const result = validateMessage(null, validatePriceUpdate, 'PriceUpdate');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('PriceUpdate: received null');
  });

  it('should return invalid result with errors for undefined', () => {
    const result = validateMessage(undefined, validatePriceUpdate, 'PriceUpdate');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('PriceUpdate: received undefined');
  });

  it('should return invalid result with errors for non-object', () => {
    const result = validateMessage('string', validatePriceUpdate, 'PriceUpdate');
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain('expected object');
  });
});

describe('validateBatch()', () => {
  it('should validate batch of messages', () => {
    const messages = [validPriceUpdate, validPriceUpdate, null, { invalid: true }];
    const result = validateBatch(messages, validatePriceUpdate, 'PriceUpdate');

    expect(result.valid).toHaveLength(2);
    expect(result.invalidCount).toBe(2);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should return all valid for valid batch', () => {
    const messages = [validPriceUpdate, validPriceUpdate];
    const result = validateBatch(messages, validatePriceUpdate, 'PriceUpdate');

    expect(result.valid).toHaveLength(2);
    expect(result.invalidCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should handle empty batch', () => {
    const result = validateBatch([], validatePriceUpdate, 'PriceUpdate');

    expect(result.valid).toHaveLength(0);
    expect(result.invalidCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createPriceUpdate()', () => {
  it('should create valid price update', () => {
    const result = createPriceUpdate({
      chain: 'ethereum',
      dex: 'uniswap_v3',
      pairKey: 'WETH-USDC',
      price: 1850
    });

    expect(result).not.toBeNull();
    expect(result!.chain).toBe('ethereum');
    expect(result!.timestamp).toBeGreaterThan(0);
  });

  it('should return null for invalid data', () => {
    const result = createPriceUpdate({ chain: '' });
    expect(result).toBeNull();
  });
});

describe('createWhaleTransaction()', () => {
  it('should create valid whale transaction', () => {
    const result = createWhaleTransaction({
      chain: 'ethereum',
      type: 'swap',
      hash: '0xhash',
      from: '0xfrom',
      to: '0xto',
      value: '1000'
    });

    expect(result).not.toBeNull();
    expect(result!.chain).toBe('ethereum');
  });

  it('should return null for invalid data', () => {
    const result = createWhaleTransaction({ chain: '' });
    expect(result).toBeNull();
  });
});

describe('createCoordinatorCommand()', () => {
  it('should create valid command', () => {
    const result = createCoordinatorCommand({ type: 'start' });

    expect(result).not.toBeNull();
    expect(result!.type).toBe('start');
    expect(result!.timestamp).toBeGreaterThan(0);
  });

  it('should return null for invalid type', () => {
    const result = createCoordinatorCommand({ type: 'invalid' as any });
    expect(result).toBeNull();
  });
});
