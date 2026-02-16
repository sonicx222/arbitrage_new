import {
  ArbitrageError,
  NetworkError,
  ValidationError,
  TimeoutError,
} from '../../src/index';

describe('ArbitrageError', () => {
  it('creates with all properties', () => {
    const err = new ArbitrageError('connection failed', 'DEX_ERROR', 'execution-engine', true);
    expect(err.message).toBe('connection failed');
    expect(err.code).toBe('DEX_ERROR');
    expect(err.service).toBe('execution-engine');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('ArbitrageError');
  });

  it('defaults retryable to false', () => {
    const err = new ArbitrageError('fail', 'CODE', 'svc');
    expect(err.retryable).toBe(false);
  });

  it('is instanceof Error', () => {
    const err = new ArbitrageError('fail', 'CODE', 'svc');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ArbitrageError);
  });

  it('has a proper stack trace', () => {
    const err = new ArbitrageError('fail', 'CODE', 'svc');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('ArbitrageError');
  });
});

describe('NetworkError', () => {
  it('sets retryable to true by default', () => {
    const err = new NetworkError('timeout', 'coordinator');
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.service).toBe('coordinator');
    expect(err.name).toBe('NetworkError');
  });

  it('is instanceof ArbitrageError and Error', () => {
    const err = new NetworkError('timeout', 'svc');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ArbitrageError);
    expect(err).toBeInstanceOf(NetworkError);
  });
});

describe('ValidationError', () => {
  it('sets field property and retryable to false', () => {
    const err = new ValidationError('invalid amount', 'execution', 'amountIn');
    expect(err.field).toBe('amountIn');
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.service).toBe('execution');
    expect(err.name).toBe('ValidationError');
  });

  it('is instanceof ArbitrageError and Error', () => {
    const err = new ValidationError('bad', 'svc', 'field');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ArbitrageError);
    expect(err).toBeInstanceOf(ValidationError);
  });
});

describe('TimeoutError', () => {
  it('creates with operation and timeout', () => {
    const err = new TimeoutError('flash loan', 5000);
    expect(err.operation).toBe('flash loan');
    expect(err.timeoutMs).toBe(5000);
    expect(err.service).toBeUndefined();
    expect(err.message).toBe('Timeout: flash loan exceeded 5000ms');
    expect(err.name).toBe('TimeoutError');
  });

  it('includes service in message when provided', () => {
    const err = new TimeoutError('bridge poll', 60000, 'cross-chain');
    expect(err.service).toBe('cross-chain');
    expect(err.message).toBe('Timeout: bridge poll exceeded 60000ms in cross-chain');
  });

  it('is instanceof Error but NOT ArbitrageError', () => {
    const err = new TimeoutError('op', 1000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).not.toBeInstanceOf(ArbitrageError);
  });
});
