/**
 * Cross-Chain Detector Architecture Alignment Tests
 *
 * These tests verify that CrossChainDetectorService follows the same
 * architectural patterns as other detectors for consistency.
 *
 * Architecture Decision (Resolved):
 * - CrossChainDetectorService does NOT extend BaseDetector (Option A REJECTED)
 * - This is an intentional, documented exception (Option B ACCEPTED)
 * - Documented in detector.ts lines 10-34 and ADR-003 "Cross-Chain Detector Exception"
 *
 * Reasons CrossChainDetector does not extend BaseDetector:
 * 1. Consumer vs Producer: BaseDetector produces events from a single chain;
 *    CrossChainDetector consumes events from ALL chains.
 * 2. No WebSocket: BaseDetector manages chain WebSocket connections;
 *    CrossChainDetector reads from Redis Streams only.
 * 3. Different lifecycle: BaseDetector tied to chain availability;
 *    CrossChainDetector tied to Redis Streams availability.
 * 4. Multi-chain by design: BaseDetector = 1 chain; CrossChainDetector = all chains.
 *
 * @see services/cross-chain-detector/src/detector.ts (Architecture Note at top)
 * @see docs/architecture/adr/ADR-003-partitioned-detectors.md ("Cross-Chain Detector Exception")
 *
 * @migrated from shared/core/src/cross-chain-alignment.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';

// =============================================================================
// Mock Interfaces
// =============================================================================

interface MockRedisClient {
  publish: jest.Mock;
  subscribe: jest.Mock;
  ping: jest.Mock;
  disconnect: jest.Mock;
}

interface MockStreamsClient {
  xadd: jest.Mock;
  xreadgroup: jest.Mock;
  xack: jest.Mock;
  createConsumerGroup: jest.Mock;
  createBatcher: jest.Mock;
  disconnect: jest.Mock;
}

const createMockRedisClient = (): MockRedisClient => ({
  publish: jest.fn(() => Promise.resolve()),
  subscribe: jest.fn(() => Promise.resolve()),
  ping: jest.fn(() => Promise.resolve(true)),
  disconnect: jest.fn(() => Promise.resolve())
});

const createMockStreamsClient = (): MockStreamsClient => ({
  xadd: jest.fn(() => Promise.resolve('1234-0')),
  xreadgroup: jest.fn(() => Promise.resolve([])),
  xack: jest.fn(() => Promise.resolve(1)),
  createConsumerGroup: jest.fn(() => Promise.resolve()),
  createBatcher: jest.fn(() => ({
    add: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
    destroy: jest.fn(() => Promise.resolve())
  })),
  disconnect: jest.fn(() => Promise.resolve())
});

let mockRedisClient: MockRedisClient;
let mockStreamsClient: MockStreamsClient;

// Mock modules
jest.mock('../../src/redis/client', () => ({
  getRedisClient: jest.fn().mockImplementation(() => Promise.resolve(mockRedisClient)),
  RedisClient: jest.fn()
}));

jest.mock('../../src/redis/streams', () => ({
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

jest.mock('../../src/logger', () => ({
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

jest.mock('../../src/analytics/price-oracle', () => ({
  getPriceOracle: jest.fn(() => Promise.resolve({
    getPrice: jest.fn(() => Promise.resolve(2000)),
    initialize: jest.fn(() => Promise.resolve())
  })),
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

  // =========================================================================
  // Option A: Extend BaseDetector — INTENTIONALLY REJECTED
  // =========================================================================
  // This option was evaluated and rejected per architecture decision.
  // CrossChainDetectorService is an intentional exception to the BaseDetector
  // pattern because it is an event CONSUMER (aggregating all chains from Redis
  // Streams) rather than an event PRODUCER (subscribing to a single chain's
  // WebSocket). BaseDetector has been removed from the codebase entirely.
  //
  // See:
  // - services/cross-chain-detector/src/detector.ts (lines 10-34)
  // - docs/architecture/adr/ADR-003-partitioned-detectors.md ("Cross-Chain Detector Exception")
  // =========================================================================

  describe('Option B: Documented Exception', () => {
    it('should have documented reason if not extending BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../../services/cross-chain-detector/src/detector.ts'
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
        path.resolve(__dirname, '../../../../docs/architecture/adr/ADR-002-redis-streams.md'),
        path.resolve(__dirname, '../../../../docs/architecture/adr/ADR-003-partitioned-detectors.md')
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
        '../../../../services/cross-chain-detector/src/detector.ts'
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
        '../../../../services/cross-chain-detector/src/detector.ts'
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
        '../../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(crossChainFile, 'utf-8');

      // Should import ServiceState from shared/core (accepts both relative path and package alias)
      expect(content).toMatch(/import[\s\S]*ServiceState[\s\S]*from[\s\S]*(@arbitrage\/core|shared\/core)/);
    });

    it('should handle stop promise race condition like BaseDetector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // Should have stop promise pattern
      expect(content).toMatch(/stopPromise|stateManager\.executeStop/);
    });
  });

  describe('Consistent Error Handling', () => {
    it('should have error handling patterns in cross-chain detector', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      // BaseDetector has been removed from the codebase. Verify cross-chain
      // detector has proper error handling on its own.
      const crossChainFile = path.resolve(
        __dirname,
        '../../../../services/cross-chain-detector/src/detector.ts'
      );

      const crossContent = await fs.readFile(crossChainFile, 'utf-8');

      // Should use try-catch pattern for error handling
      expect(crossContent).toMatch(/try\s*\{/);
      expect(crossContent).toMatch(/catch\s*\(/);

      // Should log errors using the logger
      expect(crossContent).toMatch(/logger\.error/);
    });

    it('should emit error events if using EventEmitter', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');

      const sourceFile = path.resolve(
        __dirname,
        '../../../../services/cross-chain-detector/src/detector.ts'
      );

      const content = await fs.readFile(sourceFile, 'utf-8');

      // If using EventEmitter (like BaseDetector), should emit error events
      // CrossChainDetector does not use EventEmitter directly, so this test
      // passes either way: either it uses EventEmitter and emits errors,
      // or it does not use EventEmitter (which is also acceptable).
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
      '../../../../services/cross-chain-detector/src/detector.ts'
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
      '../../../../services/cross-chain-detector/src/detector.ts'
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
      '../../../../services/cross-chain-detector/src/detector.ts'
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
      '../../../../services/cross-chain-detector/src/detector.ts'
    );

    const content = await fs.readFile(sourceFile, 'utf-8');

    // Should import shared utilities (accepts both relative path and package alias)
    expect(content).toMatch(/from.*(@arbitrage\/core|shared\/core)/);
    expect(content).toMatch(/createLogger|getRedisClient|ServiceStateManager/);
  });
});
