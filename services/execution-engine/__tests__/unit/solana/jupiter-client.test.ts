/**
 * Tests for Jupiter V6 Swap Client
 *
 * @see Phase 3 #29: Solana Execution with Jito Bundles
 */

import { JupiterSwapClient, type JupiterQuote, type JupiterSwapResult } from '../../../src/solana/jupiter-client';

// =============================================================================
// Mocks
// =============================================================================

// Mock @arbitrage/core createLogger
jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  })),
}));

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

function createMockQuote(): JupiterQuote {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: '1000000000',
    outAmount: '150000000',
    priceImpactPct: 0.01,
    routePlan: [
      {
        ammKey: 'test-amm-key',
        label: 'Raydium',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '1000000000',
        outAmount: '150000000',
        feeAmount: '300000',
        feeMint: 'So11111111111111111111111111111111111111112',
        percent: 100,
      },
    ],
  };
}

function createMockSwapResult(): JupiterSwapResult {
  return {
    swapTransaction: 'dGVzdC10cmFuc2FjdGlvbi1iYXNlNjQ=', // base64 encoded test string
    lastValidBlockHeight: 200000000,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('JupiterSwapClient', () => {
  let client: JupiterSwapClient;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    client = new JupiterSwapClient(
      {
        apiUrl: 'https://quote-api.jup.ag',
        timeoutMs: 5000,
        maxRetries: 2,
        defaultSlippageBps: 50,
      },
      createMockLogger(),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // getQuote
  // ===========================================================================

  describe('getQuote', () => {
    it('should return parsed quote on success', async () => {
      const mockQuote = createMockQuote();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockQuote),
      });

      const result = await client.getQuote(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        '1000000000',
      );

      expect(result).toEqual(mockQuote);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/quote?');
      expect(calledUrl).toContain('inputMint=So11111111111111111111111111111111111111112');
      expect(calledUrl).toContain('outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      expect(calledUrl).toContain('amount=1000000000');
      expect(calledUrl).toContain('slippageBps=50');
    });

    it('should use custom slippage when provided', async () => {
      const mockQuote = createMockQuote();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockQuote),
      });

      await client.getQuote(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        '1000000000',
        100,
      );

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('slippageBps=100');
    });
  });

  // ===========================================================================
  // getSwapTransaction
  // ===========================================================================

  describe('getSwapTransaction', () => {
    it('should return swap result on success', async () => {
      const mockSwapResult = createMockSwapResult();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSwapResult),
      });

      const quote = createMockQuote();
      const result = await client.getSwapTransaction(quote, 'testPublicKey123');

      expect(result).toEqual(mockSwapResult);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://quote-api.jup.ag/swap');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body);
      expect(body.quoteResponse).toEqual(quote);
      expect(body.userPublicKey).toBe('testPublicKey123');
      expect(body.wrapAndUnwrapSol).toBe(true);
    });
  });

  // ===========================================================================
  // Retry behavior
  // ===========================================================================

  describe('retry behavior', () => {
    it('should retry on failure and succeed on subsequent attempt', async () => {
      const mockQuote = createMockQuote();

      // First call fails, second succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockQuote),
        });

      const result = await client.getQuote(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        '1000000000',
      );

      expect(result).toEqual(mockQuote);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw after maxRetries exhausted', async () => {
      // All calls fail
      mockFetch.mockRejectedValue(new Error('Persistent network error'));

      await expect(
        client.getQuote(
          'So11111111111111111111111111111111111111112',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          '1000000000',
        ),
      ).rejects.toThrow('Persistent network error');

      // 1 initial + 2 retries = 3 total
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should throw on non-ok HTTP status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: () => Promise.resolve('Rate limited'),
      });

      await expect(
        client.getQuote(
          'So11111111111111111111111111111111111111112',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          '1000000000',
        ),
      ).rejects.toThrow('Jupiter API error: 429 Too Many Requests - Rate limited');
    });

    it('should handle abort signal timeout', async () => {
      // Simulate a timeout by never resolving
      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            }
          }),
      );

      // Create client with very short timeout for test
      const fastClient = new JupiterSwapClient(
        {
          apiUrl: 'https://quote-api.jup.ag',
          timeoutMs: 50,
          maxRetries: 0,
          defaultSlippageBps: 50,
        },
        createMockLogger(),
      );

      await expect(
        fastClient.getQuote(
          'So11111111111111111111111111111111111111112',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          '1000000000',
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // Default config
  // ===========================================================================

  describe('default configuration', () => {
    it('should use default config when no config provided', () => {
      const defaultClient = new JupiterSwapClient();
      // Client should be created without errors
      expect(defaultClient).toBeInstanceOf(JupiterSwapClient);
    });
  });

  // ===========================================================================
  // SSRF hostname validation
  // ===========================================================================

  describe('hostname validation', () => {
    it('should reject untrusted API hostnames', () => {
      expect(
        () => new JupiterSwapClient({ apiUrl: 'https://evil.internal.corp/v6' }, createMockLogger()),
      ).toThrow('Untrusted Jupiter API hostname: evil.internal.corp');
    });

    it('should reject invalid URLs', () => {
      expect(
        () => new JupiterSwapClient({ apiUrl: 'not-a-url' }, createMockLogger()),
      ).toThrow('Invalid URL');
    });

    it('should accept allowed Jupiter hostnames', () => {
      expect(
        () => new JupiterSwapClient({ apiUrl: 'https://quote-api.jup.ag/v6' }, createMockLogger()),
      ).not.toThrow();
    });
  });
});
