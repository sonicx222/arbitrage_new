import {
  createErrorResult,
  createSuccessResult,
  createSkippedResult,
  formatExecutionError,
  extractErrorCode,
  ExecutionErrorCode,
} from '../../src/execution';

describe('createErrorResult', () => {
  it('creates a failed result with required fields', () => {
    const result = createErrorResult('opp-1', 'tx reverted', 'ethereum', 'uniswap');
    expect(result.opportunityId).toBe('opp-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('tx reverted');
    expect(result.chain).toBe('ethereum');
    expect(result.dex).toBe('uniswap');
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.transactionHash).toBeUndefined();
  });

  it('includes transactionHash when provided', () => {
    const result = createErrorResult('opp-1', 'fail', 'bsc', 'pancake', '0xabc');
    expect(result.transactionHash).toBe('0xabc');
  });
});

describe('createSuccessResult', () => {
  it('creates a successful result with required fields', () => {
    const result = createSuccessResult('opp-2', '0xdef', 'polygon', 'quickswap');
    expect(result.opportunityId).toBe('opp-2');
    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0xdef');
    expect(result.chain).toBe('polygon');
    expect(result.dex).toBe('quickswap');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('includes optional fields when provided', () => {
    const result = createSuccessResult('opp-3', '0x123', 'ethereum', 'uniswap', {
      actualProfit: 0.05,
      gasUsed: 250000,
      gasCost: 0.01,
      latencyMs: 42,
      usedMevProtection: true,
    });
    expect(result.actualProfit).toBe(0.05);
    expect(result.gasUsed).toBe(250000);
    expect(result.gasCost).toBe(0.01);
    expect(result.latencyMs).toBe(42);
    expect(result.usedMevProtection).toBe(true);
  });

  it('leaves optional fields undefined when not provided', () => {
    const result = createSuccessResult('opp-4', '0x456', 'bsc', 'pancake');
    expect(result.actualProfit).toBeUndefined();
    expect(result.gasUsed).toBeUndefined();
    expect(result.latencyMs).toBeUndefined();
  });
});

describe('createSkippedResult', () => {
  it('creates a skipped (failed) result with reason as error', () => {
    const result = createSkippedResult('opp-5', 'drawdown limit', 'ethereum', 'sushi');
    expect(result.opportunityId).toBe('opp-5');
    expect(result.success).toBe(false);
    expect(result.error).toBe('drawdown limit');
    expect(result.chain).toBe('ethereum');
    expect(result.dex).toBe('sushi');
  });
});

describe('formatExecutionError', () => {
  it('returns code as-is when no details', () => {
    expect(formatExecutionError(ExecutionErrorCode.NO_CHAIN)).toBe(
      '[ERR_NO_CHAIN] No chain specified for opportunity'
    );
  });

  it('appends details after colon', () => {
    const formatted = formatExecutionError(ExecutionErrorCode.NO_WALLET, 'for polygon');
    expect(formatted).toBe('[ERR_NO_WALLET] No wallet available for chain: for polygon');
  });

  it('handles empty string details (returns code only)', () => {
    expect(formatExecutionError(ExecutionErrorCode.GAS_SPIKE, '')).toBe(
      '[ERR_GAS_SPIKE] Gas price spike detected'
    );
  });
});

describe('extractErrorCode', () => {
  it('extracts error code from formatted message', () => {
    expect(extractErrorCode('[ERR_NO_WALLET] No wallet available')).toBe('ERR_NO_WALLET');
  });

  it('extracts from all ExecutionErrorCode values', () => {
    for (const code of Object.values(ExecutionErrorCode)) {
      const extracted = extractErrorCode(code);
      expect(extracted).not.toBeNull();
      expect(extracted).toMatch(/^ERR_/);
    }
  });

  it('extracts first code when message has multiple', () => {
    expect(extractErrorCode('[ERR_FIRST] then [ERR_SECOND]')).toBe('ERR_FIRST');
  });

  it('returns null for messages without error codes', () => {
    expect(extractErrorCode('some random error')).toBeNull();
    expect(extractErrorCode('')).toBeNull();
  });

  it('returns null for malformed patterns', () => {
    expect(extractErrorCode('[ERR_lowercase]')).toBeNull();
    expect(extractErrorCode('[ERR_]')).toBeNull();
  });
});
