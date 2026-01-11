/**
 * Cross-Chain Detector Architecture Alignment Tests
 *
 * These tests verify that CrossChainDetectorService follows the same
 * architectural patterns as other detectors for consistency.
 *
 * Current State:
 * - CrossChainDetectorService does NOT extend BaseDetector
 * - Has different lifecycle management
 * - Has different error handling patterns
 *
 * Options per Architecture Alignment Plan:
 * 1. Make CrossChainDetectorService extend BaseDetector
 * 2. Create new base class hierarchy for multi-chain services
 * 3. Document as intentional exception in ADR
 *
 * TDD Approach: Tests written BEFORE implementation.
 *
 * @see architecture-alignment-plan.md Issue #3
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';

// =============================================================================
// Mock Interfaces
// =============================================================================

interface MockRedisClient {
  publish: Mock<(channel: string, message: unknown) => Promise<void>>;
  subscribe: Mock<(channel: string) => Promise<void>>;
  ping: Mock<() => Promise<boolean>>;
  disconnect: Mock<() => Promise<void>>;
}

interface MockStreamsClient {
  xadd: Mock<(stream: string, data: unknown) => Promise<string>>;
  xreadgroup: Mock<(config: unknown, options: unknown) => Promise<any[]>>;
  xack: Mock<(stream: string, group: string, id: string) => Promise<number>>;
  createConsumerGroup: Mock<(config: unknown) => Promise<void>>;
  createBatcher: Mock<(stream: string, config: unknown) => any>;
  disconnect: Mock<() => Promise<void>>;
}

const createMockRedisClient = (): MockRedisClient => ({
  publish: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  ping: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(undefined)
});

const createMockStreamsClient = (): MockStreamsClient => ({
  xadd: jest.fn().mockResolvedValue('1234-0'),
  xreadgroup: jest.fn().mockResolvedValue([]),
  xack: jest.fn().mockResolvedValue(1),
  createConsumerGroup: jest.fn().mockResolvedValue(undefined),
  createBatcher: jest.fn().mockReturnValue({
    add: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined)
  }),
  disconnect: jest.fn().mockResolvedValue(undefined)
});

let mockRedisClient: MockRedisClient;
let mockStreamsClient: MockStreamsClient;

// Mock modules
jest.mock('./redis', () => ({
  getRedisClient: jest.fn().mockImplementation(() => Promise.resolve(mockRedisClient)),
  RedisClient: jest.fn()
}));

jest.mock('./redis-streams', () => ({
  getRedisStreamsClient: jest.fn().mockImplementation(() => Promise.resolve(mockStreamsClient)),
  RedisStreamsClient: {
    STREAMS: {
      PRICE_UPDATES: 'stream:price-updates',
      SWAP_EVENTS: 'stream:swap-events',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts',
      VOLUME_AGGREGATES: 'stream:volume-aggregates'
    }
  }
}));

jest.mock('./logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  getPerformanceLogger: jest.fn(() => ({
    logEventLatency: jest.fn(),
    logArbitrageOpportunity: jest.fn(),
    logHealthCheck: jest.fn()
  }))
}));

jest.mock('./price-oracle', () => ({
  getPriceOracle: jest.fn().mockResolvedValue({
    getPrice: jest.fn().mockResolvedValue(2000),
    initialize: jest.fn().mockResolvedValue(undefined)
  }),
  resetPriceOracle: jest.fn()
}));

// =============================================================================
// Architecture Alignment Tests
// =============================================================================

describe('Cross-Chain Detector Architecture Alignment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient = createMockRedisClient();
    mockStreamsClient = createMockStreamsClient();
  });

  describe('Option A: Extend BaseDetector (Recommended)', () => {
    it('should extend BaseDetector class', async () => {
      jest.resetModules();

      // Load both classes
      const baseDetectorModule = await import('./base-detector');
      const BaseDetector = baseDetectorModule.BaseDetector;

      // Load cross-chain detector
      // Note: This import path is for the service, not shared/core
      try {
        const crossChainModule = await import(
          '../../../services/cross-chain-detector/src/detector'
        );
        const CrossChainDetectorService = crossChainModule.CrossChainDetectorService;

        // Should extend BaseDetector
        const detector = new CrossChainDetectorService();
        expect(detector).toBeInstanceOf(BaseDetector);
      } catch (importError) {
        // If import fails, check source code directly
        const fs = await import('fs/promises');
        const path = await import('path');

        const sourceFile = path.resolve(
          __dirname,
          '../../../services/cross-chain-detector/src/detector.ts'
        );

        const content = await fs.readFile(sourceFile, 'utf-8');

        // Should have extends BaseDetector
        expect(content).toMatch(/class CrossChainDetectorService extends BaseDetector/);
      }
    });

    it('should implement required abstract methods from BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // If extending BaseDetector, should implement these hooks:
      // - onStart()
      // - onStop()
      // - getChainConfig()

      // These patterns indicate proper BaseDetector integration
      const requiredPatterns = [
        /protected\s+async\s+onStart|override\s+async\s+onStart/,
        /protected\s+async\s+onStop|override\s+async\s+onStop/
      ];

      // At least implement lifecycle hooks if extending BaseDetector
      const hasLifecycleHooks = requiredPatterns.some(pattern => pattern.test(content));

      // Either extends BaseDetector OR has documented exception
      const extendsBaseDetector = content.includes('extends BaseDetector');
      const hasDocumentedException = content.includes('intentional exception') ||
        content.includes('does not extend BaseDetector');

      expect(extendsBaseDetector || hasDocumentedException).toBe(true);
    });

    it('should use BaseDetector publish methods instead of direct xadd', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // If extending BaseDetector, should use inherited publish methods
      // Count direct xadd calls (should be minimal or zero)
      const xaddCalls = (content.match(/streamsClient\.xadd/g) || []).length;

      // If many xadd calls, should use BaseDetector pattern instead
      // Allow some xadd for cross-chain specific publishing
      if (content.includes('extends BaseDetector')) {
        expect(xaddCalls).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('Option B: Documented Exception', () => {
    it('should have documented reason if not extending BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // If NOT extending BaseDetector, should have documented reason
      if (!content.includes('extends BaseDetector')) {
        // Should have comment explaining why
        expect(content).toMatch(
          /intentional|multi-chain|cross-chain\s+specific|does not extend/i
        );
      }
    });

    it('should be documented in ADR if an exception', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      // Check ADR documents
      const adrPaths = [
        path.resolve(__dirname, '../../../docs/architecture/adr/ADR-002-redis-streams.md'),
        path.resolve(__dirname, '../../../docs/architecture/adr/ADR-003-partitioned-detectors.md')
      ];

      let documentedInAdr = false;

      for (const adrPath of adrPaths) {
        try {
          const content = await fs.readFile(adrPath, 'utf-8');
          if (content.includes('CrossChainDetector') ||
              content.includes('cross-chain-detector') ||
              content.includes('cross-chain exception')) {
            documentedInAdr = true;
            break;
          }
        } catch {
          // ADR file not found
        }
      }

      // Either extends BaseDetector OR is documented as exception
      const detectorPath = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );
      const detectorContent = await fs.readFile(detectorPath, 'utf-8');

      const extendsBaseDetector = detectorContent.includes('extends BaseDetector');

      if (!extendsBaseDetector) {
        expect(documentedInAdr).toBe(true);
      }
    });
  });

  describe('Consistent Lifecycle Management', () => {
    it('should use ServiceStateManager like BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // Should use ServiceStateManager for lifecycle
      expect(content).toMatch(/ServiceStateManager|createServiceState/);
      expect(content).toMatch(/stateManager\.executeStart|stateManager\.executeStop/);
    });

    it('should have same lifecycle states as BaseDetector', async () => {
      // Both should use the same ServiceState enum
      const fs = await import('fs/promises');
      const path = await import('path');

      const crossChainFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(crossChainFile, 'utf-8');

      // Should import ServiceState from shared/core
      expect(content).toMatch(/import.*ServiceState.*from.*shared\/core/);
    });

    it('should handle stop promise race condition like BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // Should have stop promise pattern
      expect(content).toMatch(/stopPromise|stateManager\.executeStop/);
    });
  });

  describe('Consistent Error Handling', () => {
    it('should have same error handling pattern as BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      // Read both files
      const baseDetectorFile = path.resolve(__dirname, 'base-detector.ts');
      const crossChainFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const baseContent = await fs.readFile(baseDetectorFile, 'utf-8');
      const crossContent = await fs.readFile(crossChainFile, 'utf-8');

      // Both should use try-catch-finally pattern
      expect(crossContent).toMatch(/try\s*\{[\s\S]*?catch[\s\S]*?finally/);

      // Both should use ServiceState.ERROR for error states
      expect(crossContent).toMatch(/ServiceState\.ERROR|stateManager.*ERROR/);
    });

    it('should emit same error events as BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // If using EventEmitter (like BaseDetector), should emit error events
      if (content.includes('EventEmitter') || content.includes('extends BaseDetector')) {
        expect(content).toMatch(/emit\s*\(\s*['"]error['"]/);
      }
    });
  });
});

// =============================================================================
// Interface Consistency Tests
// =============================================================================

describe('Cross-Chain Detector Interface Consistency', () => {
  it('should have same public API pattern as other detectors', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const sourceFile = path.resolve(
      __dirname,
      '../../../services/cross-chain-detector/src/detector.ts'
    );

    const content = await fs.readFile(sourceFile, 'utf-8');

    // Should have standard detector methods
    expect(content).toMatch(/async\s+start\s*\(\s*\)/);
    expect(content).toMatch(/async\s+stop\s*\(\s*\)/);
    expect(content).toMatch(/getState|isRunning/);
  });

  it('should expose health information consistently', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const sourceFile = path.resolve(
      __dirname,
      '../../../services/cross-chain-detector/src/detector.ts'
    );

    const content = await fs.readFile(sourceFile, 'utf-8');

    // Should have health monitoring pattern
    expect(content).toMatch(/healthMonitor|healthCheck|getHealth/i);
  });
});

// =============================================================================
// Code Quality Tests
// =============================================================================

describe('Cross-Chain Detector Code Quality', () => {
  it('should not duplicate BaseDetector functionality', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const sourceFile = path.resolve(
      __dirname,
      '../../../services/cross-chain-detector/src/detector.ts'
    );

    const content = await fs.readFile(sourceFile, 'utf-8');

    // Should not re-implement batching if BaseDetector provides it
    const batchingImplementations = (content.match(/class.*Batcher|createBatcher/g) || []).length;

    // If extending BaseDetector, shouldn't create own batchers
    if (content.includes('extends BaseDetector')) {
      expect(batchingImplementations).toBeLessThanOrEqual(1);
    }
  });

  it('should import from shared/core for common functionality', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const sourceFile = path.resolve(
      __dirname,
      '../../../services/cross-chain-detector/src/detector.ts'
    );

    const content = await fs.readFile(sourceFile, 'utf-8');

    // Should import shared utilities
    expect(content).toMatch(/from.*shared\/core/);
    expect(content).toMatch(/createLogger|getRedisClient|ServiceStateManager/);
  });
});
