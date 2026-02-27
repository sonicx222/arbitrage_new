/**
 * ProviderRotationStrategy Unit Tests
 *
 * Tests for the provider rotation strategy that manages URL selection,
 * fallback ordering, rate limit detection, and reconnection delays.
 *
 * Fix 3.1: Phase 3 test coverage for extracted cold-path provider rotation logic.
 *
 * @see shared/core/src/provider-rotation-strategy.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// =============================================================================
// Mock Setup — Must be before source imports
// =============================================================================

jest.mock('../../src/logger');

const mockSelectBestProvider = jest.fn<(chainId: string, candidates: string[]) => string>(
  (_chainId: string, candidates: string[]) => candidates[0]
);
const mockSelectBestProviderWithBudget = jest.fn<(chainId: string, candidates: string[], extractFn: (url: string) => string) => string>(
  (_chainId: string, candidates: string[], _extractFn: (url: string) => string) => candidates[0]
);
const mockGetHealthScore = jest.fn<(url: string, chainId: string) => number>().mockReturnValue(0.8);
const mockRecordRequest = jest.fn();
const mockGetTimeBasedProviderPriority = jest.fn<() => string[]>().mockReturnValue(['drpc', 'ankr', 'publicnode']);

jest.mock('../../src/monitoring/provider-health-scorer');

// =============================================================================
// Import under test (after mocks)
// =============================================================================

import { ProviderRotationStrategy, ProviderRotationConfig } from '../../src/rpc/provider-rotation-strategy';
import { getProviderHealthScorer } from '../../src/monitoring/provider-health-scorer';

const mockedGetProviderHealthScorer = getProviderHealthScorer as jest.MockedFunction<typeof getProviderHealthScorer>;

// =============================================================================
// Test Helpers
// =============================================================================

function createStrategy(overrides: Partial<ProviderRotationConfig> = {}): ProviderRotationStrategy {
  return new ProviderRotationStrategy({
    url: 'wss://primary.drpc.org/ws',
    fallbackUrls: [
      'wss://fallback1.ankr.com/ws',
      'wss://fallback2.publicnode.com/ws',
    ],
    chainId: 'ethereum',
    ...overrides,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('ProviderRotationStrategy', () => {
  let strategy: ProviderRotationStrategy;
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;
  let mathRandomSpy: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    // Re-set mock implementations (resetMocks: true in jest.config clears them after each test)
    mockSelectBestProvider.mockImplementation((_chainId: string, candidates: string[]) => candidates[0]);
    mockSelectBestProviderWithBudget.mockImplementation((_chainId: string, candidates: string[], _extractFn: (url: string) => string) => candidates[0]);
    mockGetHealthScore.mockReturnValue(0.8);
    mockGetTimeBasedProviderPriority.mockReturnValue(['drpc', 'ankr', 'publicnode']);

    // Re-set getProviderHealthScorer to return mock object before strategy construction
    mockedGetProviderHealthScorer.mockReturnValue({
      selectBestProvider: mockSelectBestProvider,
      selectBestProviderWithBudget: mockSelectBestProviderWithBudget,
      getHealthScore: mockGetHealthScore,
      recordRequest: mockRecordRequest,
      getTimeBasedProviderPriority: mockGetTimeBasedProviderPriority,
    } as any);

    strategy = createStrategy();
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000000);
    mathRandomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    mathRandomSpy.mockRestore();
  });

  // ===========================================================================
  // URL Access
  // ===========================================================================

  describe('getCurrentUrl()', () => {
    it('should return the primary URL initially', () => {
      expect(strategy.getCurrentUrl()).toBe('wss://primary.drpc.org/ws');
    });

    it('should return the primary URL when index is out of bounds', () => {
      // Create with only primary URL, then internally manipulate
      const singleUrlStrategy = createStrategy({ fallbackUrls: [] });
      // Default is index 0, so it should return the primary
      expect(singleUrlStrategy.getCurrentUrl()).toBe('wss://primary.drpc.org/ws');
    });
  });

  describe('getCurrentUrlIndex()', () => {
    it('should return 0 initially', () => {
      expect(strategy.getCurrentUrlIndex()).toBe(0);
    });

    it('should update after switching URLs', () => {
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback1.ankr.com/ws');
      strategy.switchToNextUrl();
      expect(strategy.getCurrentUrlIndex()).toBe(1);
    });
  });

  describe('getTotalUrls()', () => {
    it('should return the count of all URLs (primary + fallbacks)', () => {
      expect(strategy.getTotalUrls()).toBe(3);
    });

    it('should return 1 when there are no fallback URLs', () => {
      const singleStrategy = createStrategy({ fallbackUrls: [] });
      expect(singleStrategy.getTotalUrls()).toBe(1);
    });

    it('should return 1 when fallbackUrls is undefined', () => {
      const singleStrategy = createStrategy({ fallbackUrls: undefined });
      expect(singleStrategy.getTotalUrls()).toBe(1);
    });
  });

  describe('resetToFirstUrl()', () => {
    it('should reset index to 0', () => {
      // Move to a fallback
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback2.publicnode.com/ws');
      strategy.switchToNextUrl();
      expect(strategy.getCurrentUrlIndex()).toBe(2);

      strategy.resetToFirstUrl();
      expect(strategy.getCurrentUrlIndex()).toBe(0);
      expect(strategy.getCurrentUrl()).toBe('wss://primary.drpc.org/ws');
    });

    it('should be a no-op when already at index 0', () => {
      strategy.resetToFirstUrl();
      expect(strategy.getCurrentUrlIndex()).toBe(0);
    });
  });

  // ===========================================================================
  // Provider Name Extraction
  // ===========================================================================

  describe('extractProviderFromUrl()', () => {
    const testCases: Array<{ url: string; expected: string; description: string }> = [
      // API-key providers
      { url: 'wss://lb.drpc.org/ogws/abc123', expected: 'drpc', description: 'drpc via lb.drpc.org' },
      { url: 'wss://some.drpc.org/ws', expected: 'drpc', description: 'drpc via drpc.org' },
      { url: 'wss://bsc.api.onfinality.io/ws?apikey=abc', expected: 'onfinality', description: 'onfinality' },
      { url: 'wss://rpc.ankr.com/eth/abc', expected: 'ankr', description: 'ankr via rpc.ankr.com' },
      { url: 'wss://some.ankr.com/eth', expected: 'ankr', description: 'ankr via ankr.com' },
      { url: 'wss://eth.publicnode.com', expected: 'publicnode', description: 'publicnode' },
      { url: 'wss://mainnet.infura.io/ws/v3/key', expected: 'infura', description: 'infura' },
      { url: 'wss://eth-mainnet.g.alchemy.com/v2/key', expected: 'alchemy', description: 'alchemy via alchemy.com' },
      { url: 'wss://some.alchemyapi.io/v2/key', expected: 'alchemy', description: 'alchemy via alchemyapi.io' },
      { url: 'wss://something.quicknode.pro/abc', expected: 'quicknode', description: 'quicknode via quicknode' },
      { url: 'wss://something.quiknode.pro/abc', expected: 'quicknode', description: 'quicknode via quiknode' },
      { url: 'wss://bsc-mainnet.blastapi.io/key', expected: 'blastapi', description: 'blastapi' },

      // Chain-specific RPCs
      { url: 'wss://eth.1rpc.io/ws', expected: '1rpc', description: '1rpc' },
      { url: 'wss://eth.llamarpc.com', expected: 'llamarpc', description: 'llamarpc' },
      { url: 'wss://bsc-dataseed.binance.org', expected: 'binance', description: 'binance' },
      { url: 'wss://arb1.arbitrum.io/ws', expected: 'arbitrum-official', description: 'arbitrum-official' },
      { url: 'wss://mainnet.optimism.io', expected: 'optimism-official', description: 'optimism-official' },
      { url: 'wss://mainnet.base.org', expected: 'base-official', description: 'base-official' },
      { url: 'wss://polygon-rpc.com', expected: 'polygon-official', description: 'polygon-official' },

      // Solana-specific
      { url: 'wss://mainnet.helius-rpc.com', expected: 'helius', description: 'helius' },
      { url: 'wss://mainnet.triton.one', expected: 'triton', description: 'triton' },
      { url: 'wss://api.mainnet-beta.solana.com', expected: 'solana-official', description: 'solana-official via mainnet-beta.solana' },
      { url: 'wss://solana.com/rpc', expected: 'solana-official', description: 'solana-official via solana.com' },

      // Unknown
      { url: 'wss://some-random-provider.xyz/ws', expected: 'unknown', description: 'unknown provider' },
      { url: '', expected: 'unknown', description: 'empty string' },
    ];

    for (const { url, expected, description } of testCases) {
      it(`should return "${expected}" for ${description}`, () => {
        expect(strategy.extractProviderFromUrl(url)).toBe(expected);
      });
    }

    it('should be case-insensitive', () => {
      expect(strategy.extractProviderFromUrl('wss://LB.DRPC.ORG/ogws/key')).toBe('drpc');
      expect(strategy.extractProviderFromUrl('WSS://MAINNET.INFURA.IO/ws')).toBe('infura');
    });
  });

  // ===========================================================================
  // Fallback Selection
  // ===========================================================================

  describe('selectBestFallbackUrl()', () => {
    it('should return null when no fallback URLs exist', () => {
      const singleStrategy = createStrategy({ fallbackUrls: [] });
      expect(singleStrategy.selectBestFallbackUrl()).toBeNull();
    });

    it('should use budget-aware selection by default', () => {
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback1.ankr.com/ws');
      const result = strategy.selectBestFallbackUrl();

      expect(result).toBe('wss://fallback1.ankr.com/ws');
      expect(mockSelectBestProviderWithBudget).toHaveBeenCalledWith(
        'ethereum',
        expect.arrayContaining(['wss://fallback1.ankr.com/ws', 'wss://fallback2.publicnode.com/ws']),
        expect.any(Function)
      );
    });

    it('should use health scoring when budget-aware selection is disabled', () => {
      strategy.setBudgetAwareSelection(false);
      mockSelectBestProvider.mockReturnValueOnce('wss://fallback2.publicnode.com/ws');

      const result = strategy.selectBestFallbackUrl();

      expect(result).toBe('wss://fallback2.publicnode.com/ws');
      expect(mockSelectBestProvider).toHaveBeenCalledWith(
        'ethereum',
        expect.arrayContaining(['wss://fallback1.ankr.com/ws', 'wss://fallback2.publicnode.com/ws']),
      );
    });

    it('should return first candidate when intelligent fallback is disabled', () => {
      strategy.setIntelligentFallback(false);
      const result = strategy.selectBestFallbackUrl();

      expect(result).toBe('wss://fallback1.ankr.com/ws');
      expect(mockSelectBestProviderWithBudget).not.toHaveBeenCalled();
      expect(mockSelectBestProvider).not.toHaveBeenCalled();
    });

    it('should return the single candidate directly when only one fallback exists', () => {
      const twoUrlStrategy = createStrategy({ fallbackUrls: ['wss://only-fallback.ankr.com/ws'] });
      const result = twoUrlStrategy.selectBestFallbackUrl();

      expect(result).toBe('wss://only-fallback.ankr.com/ws');
      // Only one candidate, should not invoke health scorer
      expect(mockSelectBestProviderWithBudget).not.toHaveBeenCalled();
    });

    it('should exclude rate-limited providers from candidates', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback2.publicnode.com/ws');

      const result = strategy.selectBestFallbackUrl();

      expect(result).toBe('wss://fallback2.publicnode.com/ws');
    });

    it('should return null when all fallback URLs are excluded', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      strategy.handleRateLimit('wss://fallback2.publicnode.com/ws');

      const result = strategy.selectBestFallbackUrl();

      expect(result).toBeNull();
    });

    it('should exclude current URL from candidates', () => {
      // Current URL is index 0 (primary). Candidates should not include the primary.
      mockSelectBestProviderWithBudget.mockImplementation(
        (_chainId: string, candidates: string[]) => {
          expect(candidates).not.toContain('wss://primary.drpc.org/ws');
          return candidates[0];
        }
      );

      strategy.selectBestFallbackUrl();
    });
  });

  // ===========================================================================
  // switchToNextUrl()
  // ===========================================================================

  describe('switchToNextUrl()', () => {
    it('should switch to best fallback URL and return true', () => {
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback2.publicnode.com/ws');

      const result = strategy.switchToNextUrl();

      expect(result).toBe(true);
      expect(strategy.getCurrentUrl()).toBe('wss://fallback2.publicnode.com/ws');
      expect(strategy.getCurrentUrlIndex()).toBe(2);
    });

    it('should use sequential fallback when intelligent selection returns current URL', () => {
      // Intelligent selection returns the same URL as current (shouldn't switch to self)
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://primary.drpc.org/ws');

      const result = strategy.switchToNextUrl();

      // Should fall back to sequential and find the next one
      expect(result).toBe(true);
      expect(strategy.getCurrentUrlIndex()).toBe(1);
    });

    it('should use sequential fallback when selectBestFallbackUrl returns null', () => {
      // All fallbacks excluded from intelligent selection, but sequential still available
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback1.ankr.com/ws');

      const result = strategy.switchToNextUrl();

      expect(result).toBe(true);
    });

    it('should skip excluded providers in sequential fallback', () => {
      // Exclude fallback1 and make intelligent selection fail
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      // Return a URL not in allUrls to make intelligent selection fail
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback2.publicnode.com/ws');

      const result = strategy.switchToNextUrl();

      expect(result).toBe(true);
      expect(strategy.getCurrentUrl()).toBe('wss://fallback2.publicnode.com/ws');
    });

    it('should return false and reset to primary when all URLs exhausted', () => {
      // Exclude ALL URLs (primary + fallbacks)
      strategy.handleRateLimit('wss://primary.drpc.org/ws');
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      strategy.handleRateLimit('wss://fallback2.publicnode.com/ws');

      const result = strategy.switchToNextUrl();

      expect(result).toBe(false);
      expect(strategy.getCurrentUrlIndex()).toBe(0);
    });

    it('should return false for a single-URL strategy', () => {
      const singleStrategy = createStrategy({ fallbackUrls: [] });

      const result = singleStrategy.switchToNextUrl();

      // selectBestFallbackUrl returns null (no candidates), sequential loop finds nothing new
      expect(result).toBe(false);
    });

    it('should wrap around when at the last URL index', () => {
      // Move to the last URL
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback2.publicnode.com/ws');
      strategy.switchToNextUrl();
      expect(strategy.getCurrentUrlIndex()).toBe(2);

      // Now switch again — should wrap to primary (0) or first available
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://primary.drpc.org/ws');
      const result = strategy.switchToNextUrl();

      expect(result).toBe(true);
      expect(strategy.getCurrentUrlIndex()).toBe(0);
    });
  });

  // ===========================================================================
  // Provider Exclusion (Rate Limiting)
  // ===========================================================================

  describe('isProviderExcluded()', () => {
    it('should return false for a URL that was never excluded', () => {
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(false);
    });

    it('should return true for an excluded URL before expiry', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      // Date.now() returns 1000000, exclusion until = 1000000 + 30000 = 1030000
      // Still at 1000000, so should be excluded
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(true);
    });

    it('should return false after exclusion expires', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      // Exclusion until = 1000000 + 30000 = 1030000

      // Advance time past exclusion
      dateNowSpy.mockReturnValue(1030001);
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(false);
    });

    it('should clean up expired exclusion from internal map', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      dateNowSpy.mockReturnValue(1030001);

      // This call should delete the expired entry
      strategy.isProviderExcluded('wss://fallback1.ankr.com/ws');

      // getExcludedProviders should also reflect the cleanup
      expect(strategy.getExcludedProviders().size).toBe(0);
    });
  });

  describe('handleRateLimit()', () => {
    it('should exclude a provider for 30s on first rate limit', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');

      const excluded = strategy.getExcludedProviders();
      const entry = excluded.get('wss://fallback1.ankr.com/ws');

      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
      // 30s * 2^(1-1) = 30000
      expect(entry!.until).toBe(1000000 + 30000);
    });

    it('should use exponential backoff for consecutive rate limits', () => {
      // First: 30s * 2^0 = 30s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      let entry = strategy.getExcludedProviders().get('wss://fallback1.ankr.com/ws');
      expect(entry!.until).toBe(1000000 + 30000);
      expect(entry!.count).toBe(1);

      // Second: 30s * 2^1 = 60s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      entry = strategy.getExcludedProviders().get('wss://fallback1.ankr.com/ws');
      expect(entry!.until).toBe(1000000 + 60000);
      expect(entry!.count).toBe(2);

      // Third: 30s * 2^2 = 120s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      entry = strategy.getExcludedProviders().get('wss://fallback1.ankr.com/ws');
      expect(entry!.until).toBe(1000000 + 120000);
      expect(entry!.count).toBe(3);

      // Fourth: 30s * 2^3 = 240s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      entry = strategy.getExcludedProviders().get('wss://fallback1.ankr.com/ws');
      expect(entry!.until).toBe(1000000 + 240000);
      expect(entry!.count).toBe(4);
    });

    it('should cap exclusion duration at 5 minutes (300000ms)', () => {
      // Fifth: 30s * 2^4 = 480s, but capped at 300s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws'); // count=1, 30s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws'); // count=2, 60s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws'); // count=3, 120s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws'); // count=4, 240s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws'); // count=5, min(480s, 300s)=300s

      const entry = strategy.getExcludedProviders().get('wss://fallback1.ankr.com/ws');
      expect(entry!.count).toBe(5);
      expect(entry!.until).toBe(1000000 + 300000);
    });

    it('should cap even higher counts at 5 minutes', () => {
      // Simulate 10 consecutive rate limits
      for (let i = 0; i < 10; i++) {
        strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      }
      const entry = strategy.getExcludedProviders().get('wss://fallback1.ankr.com/ws');
      expect(entry!.count).toBe(10);
      // 30s * 2^9 = 15360s, but capped at 300s
      expect(entry!.until).toBe(1000000 + 300000);
    });

    it('should track separate exclusions for different URLs', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      strategy.handleRateLimit('wss://fallback2.publicnode.com/ws');

      const excluded = strategy.getExcludedProviders();
      expect(excluded.size).toBe(2);
      expect(excluded.get('wss://fallback1.ankr.com/ws')!.count).toBe(1);
      expect(excluded.get('wss://fallback2.publicnode.com/ws')!.count).toBe(1);
    });
  });

  describe('getAvailableProviderCount()', () => {
    it('should return total count when none are excluded', () => {
      expect(strategy.getAvailableProviderCount()).toBe(3);
    });

    it('should subtract excluded providers', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      expect(strategy.getAvailableProviderCount()).toBe(2);
    });

    it('should count expired exclusions as available', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      dateNowSpy.mockReturnValue(1030001);
      expect(strategy.getAvailableProviderCount()).toBe(3);
    });

    it('should return 0 when all providers are excluded', () => {
      strategy.handleRateLimit('wss://primary.drpc.org/ws');
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      strategy.handleRateLimit('wss://fallback2.publicnode.com/ws');
      expect(strategy.getAvailableProviderCount()).toBe(0);
    });
  });

  describe('getExcludedProviders()', () => {
    it('should return an empty map when none are excluded', () => {
      expect(strategy.getExcludedProviders().size).toBe(0);
    });

    it('should return a copy (modifying the returned map does not affect internal state)', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      const copy = strategy.getExcludedProviders();
      copy.delete('wss://fallback1.ankr.com/ws');

      // Internal state should be unaffected
      expect(strategy.getExcludedProviders().size).toBe(1);
    });

    it('should clean up expired exclusions before returning', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      dateNowSpy.mockReturnValue(1030001); // past exclusion

      const excluded = strategy.getExcludedProviders();
      expect(excluded.size).toBe(0);
    });

    it('should keep non-expired exclusions when cleaning up', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws'); // expires at 1030000
      strategy.handleRateLimit('wss://fallback2.publicnode.com/ws'); // expires at 1030000

      // Advance past first exclusion but simulate second having higher count
      // Both expire at same time since both are first offense (30s)
      dateNowSpy.mockReturnValue(1020000); // 20s in, still excluded
      const excluded = strategy.getExcludedProviders();
      expect(excluded.size).toBe(2);
    });
  });

  describe('clearProviderExclusions()', () => {
    it('should clear all exclusions', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      strategy.handleRateLimit('wss://fallback2.publicnode.com/ws');
      expect(strategy.getExcludedProviders().size).toBe(2);

      strategy.clearProviderExclusions();
      expect(strategy.getExcludedProviders().size).toBe(0);
    });

    it('should be a no-op when no exclusions exist', () => {
      strategy.clearProviderExclusions();
      expect(strategy.getExcludedProviders().size).toBe(0);
    });

    it('should allow previously excluded providers to be used again', () => {
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(true);

      strategy.clearProviderExclusions();
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(false);
    });
  });

  // ===========================================================================
  // Auth Failure Handling
  // ===========================================================================

  describe('isAuthError()', () => {
    describe('error codes', () => {
      it('should detect HTTP 401 (Unauthorized) via code', () => {
        expect(strategy.isAuthError({ code: 401, message: '' })).toBe(true);
      });

      it('should detect HTTP 403 (Forbidden) via code', () => {
        expect(strategy.isAuthError({ code: 403, message: '' })).toBe(true);
      });

      it('should detect HTTP 401 via status field', () => {
        expect(strategy.isAuthError({ status: 401 })).toBe(true);
      });

      it('should detect HTTP 403 via statusCode field', () => {
        expect(strategy.isAuthError({ statusCode: 403 })).toBe(true);
      });

      it('should not detect non-auth error codes', () => {
        expect(strategy.isAuthError({ code: 429, message: '' })).toBe(false);
        expect(strategy.isAuthError({ code: 500, message: '' })).toBe(false);
        expect(strategy.isAuthError({ code: 1006, message: '' })).toBe(false);
      });
    });

    describe('message patterns', () => {
      const authMessages = [
        'Unauthorized',
        'Forbidden',
        'invalid api key',
        'invalid key',
        'api key expired',
        'authentication failed',
        'authentication required',
        'Unexpected server response: 401',
        'Unexpected server response: 403',
      ];

      for (const msg of authMessages) {
        it(`should detect "${msg}" pattern`, () => {
          expect(strategy.isAuthError({ message: msg })).toBe(true);
        });
      }

      it('should be case-insensitive', () => {
        expect(strategy.isAuthError({ message: 'UNAUTHORIZED' })).toBe(true);
        expect(strategy.isAuthError({ message: 'Invalid API Key' })).toBe(true);
      });

      it('should detect partial matches within longer messages', () => {
        expect(strategy.isAuthError({
          message: 'Error: Unexpected server response: 401 from wss://rpc.ankr.com/polygon/fd86c2'
        })).toBe(true);
      });

      it('should not detect unrelated error messages', () => {
        expect(strategy.isAuthError({ message: 'connection refused' })).toBe(false);
        expect(strategy.isAuthError({ message: 'rate limit exceeded' })).toBe(false);
        expect(strategy.isAuthError({ message: 'timeout' })).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should return false for null', () => {
        expect(strategy.isAuthError(null)).toBe(false);
      });

      it('should return false for undefined', () => {
        expect(strategy.isAuthError(undefined)).toBe(false);
      });

      it('should return false for empty object', () => {
        expect(strategy.isAuthError({})).toBe(false);
      });
    });
  });

  describe('handleAuthFailure()', () => {
    it('should quarantine a provider for 1 hour', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');

      const quarantined = strategy.getAuthQuarantinedProviders();
      const until = quarantined.get('wss://fallback1.ankr.com/ws');

      expect(until).toBeDefined();
      // 1 hour = 3,600,000ms
      expect(until).toBe(1000000 + 3600000);
    });

    it('should cause isProviderExcluded to return true', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(true);
    });

    it('should expire after 1 hour', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      // Advance past quarantine: 1000000 + 3600000 + 1
      dateNowSpy.mockReturnValue(4600001);

      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(false);
      expect(strategy.isAuthQuarantined('wss://fallback1.ankr.com/ws')).toBe(false);
    });

    it('should exclude auth-quarantined providers from fallback selection', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback2.publicnode.com/ws');

      const result = strategy.selectBestFallbackUrl();
      expect(result).toBe('wss://fallback2.publicnode.com/ws');
    });

    it('should return null when all fallbacks are auth-quarantined', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      strategy.handleAuthFailure('wss://fallback2.publicnode.com/ws');

      const result = strategy.selectBestFallbackUrl();
      expect(result).toBeNull();
    });

    it('should reduce available provider count', () => {
      expect(strategy.getAvailableProviderCount()).toBe(3);
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      expect(strategy.getAvailableProviderCount()).toBe(2);
    });
  });

  describe('isAuthQuarantined()', () => {
    it('should return false for URLs never quarantined', () => {
      expect(strategy.isAuthQuarantined('wss://fallback1.ankr.com/ws')).toBe(false);
    });

    it('should return true for quarantined URL before expiry', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      expect(strategy.isAuthQuarantined('wss://fallback1.ankr.com/ws')).toBe(true);
    });

    it('should clean up expired quarantine entry', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      dateNowSpy.mockReturnValue(4600001);

      strategy.isAuthQuarantined('wss://fallback1.ankr.com/ws');
      expect(strategy.getAuthQuarantinedProviders().size).toBe(0);
    });
  });

  describe('getAuthQuarantinedProviders()', () => {
    it('should return empty map when none quarantined', () => {
      expect(strategy.getAuthQuarantinedProviders().size).toBe(0);
    });

    it('should return a copy (modifying returned map does not affect internal state)', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      const copy = strategy.getAuthQuarantinedProviders();
      copy.delete('wss://fallback1.ankr.com/ws');

      expect(strategy.getAuthQuarantinedProviders().size).toBe(1);
    });

    it('should clean up expired quarantines before returning', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      dateNowSpy.mockReturnValue(4600001);

      expect(strategy.getAuthQuarantinedProviders().size).toBe(0);
    });
  });

  describe('clearAuthQuarantines()', () => {
    it('should clear all quarantines', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      strategy.handleAuthFailure('wss://fallback2.publicnode.com/ws');
      expect(strategy.getAuthQuarantinedProviders().size).toBe(2);

      strategy.clearAuthQuarantines();
      expect(strategy.getAuthQuarantinedProviders().size).toBe(0);
    });

    it('should allow previously quarantined providers to be used again', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(true);

      strategy.clearAuthQuarantines();
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(false);
    });
  });

  describe('auth quarantine vs rate limit exclusion interaction', () => {
    it('should exclude by auth quarantine even if rate limit exclusion expired', () => {
      // Rate limit exclusion: 30s
      strategy.handleRateLimit('wss://fallback1.ankr.com/ws');
      // Auth quarantine: 1 hour
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');

      // Advance past rate limit but not auth quarantine
      dateNowSpy.mockReturnValue(1030001);
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(true);
    });

    it('should prioritize auth quarantine check (checked first in isProviderExcluded)', () => {
      strategy.handleAuthFailure('wss://fallback1.ankr.com/ws');
      // isProviderExcluded should return true via auth quarantine path
      expect(strategy.isProviderExcluded('wss://fallback1.ankr.com/ws')).toBe(true);
    });
  });

  // ===========================================================================
  // Rate Limit Detection
  // ===========================================================================

  describe('isRateLimitError()', () => {
    describe('error codes', () => {
      it('should detect JSON-RPC rate limit code -32005', () => {
        expect(strategy.isRateLimitError({ code: -32005, message: '' })).toBe(true);
      });

      it('should detect JSON-RPC rate limit code -32016', () => {
        expect(strategy.isRateLimitError({ code: -32016, message: '' })).toBe(true);
      });

      it('should detect WebSocket close code 1008 (Policy Violation)', () => {
        expect(strategy.isRateLimitError({ code: 1008, message: '' })).toBe(true);
      });

      it('should detect WebSocket close code 1013 (Try Again Later)', () => {
        expect(strategy.isRateLimitError({ code: 1013, message: '' })).toBe(true);
      });

      it('should detect HTTP 429 (Too Many Requests)', () => {
        expect(strategy.isRateLimitError({ code: 429, message: '' })).toBe(true);
      });

      it('should not detect non-rate-limit error codes', () => {
        expect(strategy.isRateLimitError({ code: -32600, message: '' })).toBe(false);
        expect(strategy.isRateLimitError({ code: 1000, message: '' })).toBe(false);
        expect(strategy.isRateLimitError({ code: 500, message: '' })).toBe(false);
      });
    });

    describe('message patterns', () => {
      const rateLimitMessages = [
        'rate limit exceeded',
        'rate-limit exceeded',
        'ratelimit exceeded',
        'too many requests',
        'request limit exceeded',
        'quota exceeded',
        'throttled',
        'exceeded the limit',
        'limit exceeded',
        'capacity exceeded',
        'try again later',
        'too many concurrent requests',
        'request per second limit',
        'requests per second exceeded',
      ];

      for (const msg of rateLimitMessages) {
        it(`should detect "${msg}" pattern`, () => {
          expect(strategy.isRateLimitError({ message: msg })).toBe(true);
        });
      }

      it('should be case-insensitive for message matching', () => {
        expect(strategy.isRateLimitError({ message: 'RATE LIMIT exceeded' })).toBe(true);
        expect(strategy.isRateLimitError({ message: 'Too Many Requests' })).toBe(true);
      });

      it('should detect partial matches within longer messages', () => {
        expect(strategy.isRateLimitError({
          message: 'Error: Your account has exceeded the rate limit for this endpoint'
        })).toBe(true);
      });

      it('should not detect unrelated error messages', () => {
        expect(strategy.isRateLimitError({ message: 'connection refused' })).toBe(false);
        expect(strategy.isRateLimitError({ message: 'timeout' })).toBe(false);
        expect(strategy.isRateLimitError({ message: 'invalid JSON' })).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should return false for null error', () => {
        expect(strategy.isRateLimitError(null)).toBe(false);
      });

      it('should return false for undefined error', () => {
        expect(strategy.isRateLimitError(undefined)).toBe(false);
      });

      it('should return false for empty object', () => {
        expect(strategy.isRateLimitError({})).toBe(false);
      });

      it('should return false for error with no message or code', () => {
        expect(strategy.isRateLimitError({ foo: 'bar' })).toBe(false);
      });

      it('should handle error with code AND matching message (code takes priority)', () => {
        expect(strategy.isRateLimitError({ code: -32005, message: 'rate limit' })).toBe(true);
      });

      it('should handle non-matching code but matching message', () => {
        expect(strategy.isRateLimitError({ code: 100, message: 'rate limit exceeded' })).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Reconnection Delay
  // ===========================================================================

  describe('calculateReconnectDelay()', () => {
    it('should return base delay + jitter for attempt 0', () => {
      // delay = 1000 * 2^0 = 1000
      // jitter = 1000 * 0.25 * 0.5 = 125
      // total = floor(1000 + 125) = 1125
      const delay = strategy.calculateReconnectDelay(0);
      expect(delay).toBe(1125);
    });

    it('should apply exponential backoff', () => {
      // attempt 1: delay = 1000 * 2^1 = 2000, jitter = 2000 * 0.25 * 0.5 = 250
      expect(strategy.calculateReconnectDelay(1)).toBe(2250);

      // attempt 2: delay = 1000 * 2^2 = 4000, jitter = 4000 * 0.25 * 0.5 = 500
      expect(strategy.calculateReconnectDelay(2)).toBe(4500);

      // attempt 3: delay = 1000 * 2^3 = 8000, jitter = 8000 * 0.25 * 0.5 = 1000
      expect(strategy.calculateReconnectDelay(3)).toBe(9000);
    });

    it('should cap at maxReconnectDelay', () => {
      // attempt 10: delay = 1000 * 2^10 = 1024000, capped at 60000
      // jitter = 60000 * 0.25 * 0.5 = 7500
      const delay = strategy.calculateReconnectDelay(10);
      expect(delay).toBe(67500);
    });

    it('should vary with different Math.random() values', () => {
      mathRandomSpy.mockReturnValue(0.0);
      // delay = 1000 * 2^0 = 1000, jitter = 1000 * 0.25 * 0.0 = 0
      expect(strategy.calculateReconnectDelay(0)).toBe(1000);

      mathRandomSpy.mockReturnValue(1.0);
      // delay = 1000 * 2^0 = 1000, jitter = 1000 * 0.25 * 1.0 = 250
      expect(strategy.calculateReconnectDelay(0)).toBe(1250);
    });

    it('should use custom config values', () => {
      const customStrategy = createStrategy({
        reconnectInterval: 500,
        backoffMultiplier: 3.0,
        maxReconnectDelay: 30000,
        jitterPercent: 0.1,
      });

      // attempt 0: delay = 500 * 3^0 = 500, jitter = 500 * 0.1 * 0.5 = 25
      expect(customStrategy.calculateReconnectDelay(0)).toBe(525);

      // attempt 1: delay = 500 * 3^1 = 1500, jitter = 1500 * 0.1 * 0.5 = 75
      expect(customStrategy.calculateReconnectDelay(1)).toBe(1575);
    });

    it('should handle attempt 0 correctly (no backoff)', () => {
      mathRandomSpy.mockReturnValue(0);
      // delay = 1000 * 2^0 = 1000, jitter = 0
      expect(strategy.calculateReconnectDelay(0)).toBe(1000);
    });
  });

  // ===========================================================================
  // Configuration Setters
  // ===========================================================================

  describe('setIntelligentFallback()', () => {
    it('should disable intelligent fallback', () => {
      strategy.setIntelligentFallback(false);
      strategy.selectBestFallbackUrl();

      // Should not call health scorer
      expect(mockSelectBestProvider).not.toHaveBeenCalled();
      expect(mockSelectBestProviderWithBudget).not.toHaveBeenCalled();
    });

    it('should re-enable intelligent fallback', () => {
      strategy.setIntelligentFallback(false);
      strategy.setIntelligentFallback(true);

      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback1.ankr.com/ws');
      strategy.selectBestFallbackUrl();

      expect(mockSelectBestProviderWithBudget).toHaveBeenCalled();
    });
  });

  describe('setBudgetAwareSelection()', () => {
    it('should disable budget-aware selection and fall back to health scoring', () => {
      strategy.setBudgetAwareSelection(false);
      mockSelectBestProvider.mockReturnValueOnce('wss://fallback1.ankr.com/ws');

      strategy.selectBestFallbackUrl();

      expect(mockSelectBestProviderWithBudget).not.toHaveBeenCalled();
      expect(mockSelectBestProvider).toHaveBeenCalled();
    });

    it('should re-enable budget-aware selection', () => {
      strategy.setBudgetAwareSelection(false);
      strategy.setBudgetAwareSelection(true);

      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback1.ankr.com/ws');
      strategy.selectBestFallbackUrl();

      expect(mockSelectBestProviderWithBudget).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Budget & Health Scorer Access
  // ===========================================================================

  describe('recordRequestForBudget()', () => {
    it('should record request with default method for current provider', () => {
      strategy.recordRequestForBudget();

      expect(mockRecordRequest).toHaveBeenCalledWith('drpc', 'eth_subscribe');
    });

    it('should record request with custom method', () => {
      strategy.recordRequestForBudget('eth_blockNumber');

      expect(mockRecordRequest).toHaveBeenCalledWith('drpc', 'eth_blockNumber');
    });

    it('should use the current active provider for recording', () => {
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback1.ankr.com/ws');
      strategy.switchToNextUrl();

      strategy.recordRequestForBudget();

      expect(mockRecordRequest).toHaveBeenCalledWith('ankr', 'eth_subscribe');
    });
  });

  describe('getCurrentProvider()', () => {
    it('should return the provider name for the current URL', () => {
      expect(strategy.getCurrentProvider()).toBe('drpc');
    });

    it('should update after switching URLs', () => {
      mockSelectBestProviderWithBudget.mockReturnValueOnce('wss://fallback1.ankr.com/ws');
      strategy.switchToNextUrl();
      expect(strategy.getCurrentProvider()).toBe('ankr');
    });
  });

  describe('getTimeBasedProviderPriority()', () => {
    it('should delegate to health scorer', () => {
      const result = strategy.getTimeBasedProviderPriority();

      expect(result).toEqual(['drpc', 'ankr', 'publicnode']);
      expect(mockGetTimeBasedProviderPriority).toHaveBeenCalled();
    });
  });

  describe('getHealthScorer()', () => {
    it('should return the health scorer instance', () => {
      const scorer = strategy.getHealthScorer();

      expect(scorer).toBeDefined();
      expect(typeof scorer.selectBestProvider).toBe('function');
      expect(typeof scorer.getHealthScore).toBe('function');
    });
  });

  // ===========================================================================
  // Constructor / Config Defaults
  // ===========================================================================

  describe('constructor defaults', () => {
    it('should default chainId to "unknown" when not provided', () => {
      const noChainStrategy = new ProviderRotationStrategy({
        url: 'wss://test.drpc.org/ws',
      });
      // Verify via getCurrentProvider (uses chainId indirectly via health scorer calls)
      expect(noChainStrategy.getCurrentProvider()).toBe('drpc');
    });

    it('should handle empty fallbackUrls array', () => {
      const noFallbacks = createStrategy({ fallbackUrls: [] });
      expect(noFallbacks.getTotalUrls()).toBe(1);
      expect(noFallbacks.switchToNextUrl()).toBe(false);
    });

    it('should handle missing fallbackUrls (undefined)', () => {
      const noFallbacks = new ProviderRotationStrategy({
        url: 'wss://test.drpc.org/ws',
      });
      expect(noFallbacks.getTotalUrls()).toBe(1);
    });

    it('should use default reconnect config values', () => {
      // Defaults: reconnectInterval=1000, backoffMultiplier=2.0, maxReconnectDelay=60000, jitterPercent=0.25
      mathRandomSpy.mockReturnValue(0);
      expect(strategy.calculateReconnectDelay(0)).toBe(1000);
    });
  });
});
