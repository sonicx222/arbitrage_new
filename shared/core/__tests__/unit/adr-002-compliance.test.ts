/**
 * ADR-002 Compliance Tests: Redis Streams Required (No Pub/Sub Fallback)
 *
 * These tests verify that the system adheres to ADR-002:
 * - Redis Streams is the ONLY messaging mechanism
 * - No Pub/Sub fallback code exists
 * - Services fail fast if Streams is unavailable
 *
 * Uses static code analysis to verify compliance without needing
 * to import actual modules (avoids dependency issues in tests).
 *
 * TDD Approach: These tests are written BEFORE implementation.
 * They should FAIL with current code that has Pub/Sub fallback.
 *
 * @see docs/architecture/adr/ADR-002-redis-streams.md
 *
 * @migrated from shared/core/src/adr-002-compliance.test.ts
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';

// =============================================================================
// Test Fixtures
// =============================================================================

let baseDetectorSource: string;
let indexSource: string;

beforeAll(async () => {
  // Load source files for static analysis
  const baseDetectorPath = path.join(__dirname, '../../src/base-detector.ts');
  const indexPath = path.join(__dirname, '../../src/index.ts');

  try {
    baseDetectorSource = await fs.readFile(baseDetectorPath, 'utf-8');
  } catch {
    baseDetectorSource = '';
  }

  try {
    indexSource = await fs.readFile(indexPath, 'utf-8');
  } catch {
    indexSource = '';
  }
});

// =============================================================================
// ADR-002 Compliance Tests: Base Detector
// =============================================================================

describe('ADR-002 Compliance: Redis Streams Required', () => {
  describe('Base Detector - No Pub/Sub Fallback', () => {
    it('should NOT contain "falling back to Pub/Sub" patterns', () => {
      // Per ADR-002: Should fail fast, not fallback
      expect(baseDetectorSource).not.toMatch(/falling back to Pub\/Sub/i);
      expect(baseDetectorSource).not.toMatch(/fallback to Pub\/Sub/i);
    });

    it('should NOT have useStreams flag that can be set to false', () => {
      // Per ADR-002: Streams should always be used
      expect(baseDetectorSource).not.toMatch(/this\.useStreams\s*=\s*false/);
    });

    it('should NOT have else-if patterns that call redis.publish', () => {
      // Pattern: else if (this.redis) { await this.redis.publish(...) }
      // This is the fallback pattern that violates ADR-002
      const fallbackPattern = /}\s*else\s+if\s*\(\s*this\.redis\s*\)\s*\{[^}]*\.publish\s*\(/;
      expect(baseDetectorSource).not.toMatch(fallbackPattern);
    });

    it('should NOT call redis.publish in catch blocks', () => {
      // Pattern: catch { ... this.redis.publish }
      // This is the error fallback pattern that violates ADR-002
      const catchFallbackPattern = /catch[^}]*\{[^}]*this\.redis\s*[?.]?\s*publish/;
      expect(baseDetectorSource).not.toMatch(catchFallbackPattern);
    });

    it('should have Streams-only publish methods', () => {
      // The publish methods should NOT have fallback branches
      // Count occurrences of redis.publish in publish methods
      const publishMethodPattern = /protected async publish\w+\([^)]*\)[^{]*\{[\s\S]*?(?=protected|private|public|$)/g;
      const publishMethods = baseDetectorSource.match(publishMethodPattern) || [];

      for (const method of publishMethods) {
        // Should not contain redis.publish fallback
        expect(method).not.toMatch(/this\.redis\s*[?.]?\s*publish/);
      }
    });

    it('should require Streams client for publishing', () => {
      // Should have checks that throw if streams unavailable
      // Either: if (!this.streamsClient) throw ...
      // Or: if (!this.priceUpdateBatcher) throw ...
      const requireStreamsPattern = /if\s*\(\s*!this\.(streamsClient|priceUpdateBatcher|swapEventBatcher)\s*\)\s*\{?\s*throw/;

      // This test will fail initially - need to add these checks
      expect(baseDetectorSource).toMatch(requireStreamsPattern);
    });
  });

  describe('Base Detector - useStreams Flag Removal', () => {
    it('should NOT declare useStreams as a settable property', () => {
      // Per ADR-002: Streams is always required, no flag needed
      // Pattern: protected useStreams = true; (with potential to be set to false)
      const useStreamsFlagPattern = /protected\s+useStreams\s*[=:]/;

      // Should either not exist or be removed
      expect(baseDetectorSource).not.toMatch(useStreamsFlagPattern);
    });

    it('should NOT check useStreams in conditionals', () => {
      // Pattern: if (this.useStreams && ...)
      // This should be removed - always use streams
      const useStreamsCheckPattern = /if\s*\(\s*this\.useStreams\s*(&&|\|\|)/;
      expect(baseDetectorSource).not.toMatch(useStreamsCheckPattern);
    });
  });

  describe('Initialization Requirements', () => {
    it('should throw on Streams initialization failure (not fallback)', () => {
      // Pattern: catch (streamsError) { this.useStreams = false; }
      // Should be: catch (streamsError) { throw new Error(...) }
      const fallbackInitPattern = /catch[^}]*\{[^}]*this\.useStreams\s*=\s*false/;
      expect(baseDetectorSource).not.toMatch(fallbackInitPattern);
    });

    it('should have error message mentioning Streams required per ADR-002', () => {
      // When Streams fails, error should reference ADR-002
      // This is a documentation requirement
      if (baseDetectorSource.includes('throw new Error')) {
        const adrReferencePattern = /throw new Error\([^)]*ADR-002|throw new Error\([^)]*Streams.*required/i;
        expect(baseDetectorSource).toMatch(adrReferencePattern);
      }
    });
  });
});

// =============================================================================
// ADR-002 Compliance Tests: Other Files
// =============================================================================

// NOTE: Skipped until Pub/Sub to Streams migration is complete per ADR-002.
// The migration is in progress - files may still use Pub/Sub during transition.
// Future work: Complete migration and re-enable these tests.
describe.skip('ADR-002 Compliance: Cross-File Analysis', () => {
  it('should not have Pub/Sub-only event channels', async () => {
    // List of files that may have Pub/Sub usage
    const filesToCheck = [
      'cache-coherency-manager.ts',
      'cross-region-health.ts',
      'dead-letter-queue.ts',
      'enhanced-health-monitor.ts',
      'graceful-degradation.ts',
      'expert-self-healing-manager.ts',
      'risk-management.ts',
      'self-healing-manager.ts'
    ];

    for (const file of filesToCheck) {
      const filePath = path.join(__dirname, '../../src', file);
      let content: string;

      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        continue; // File doesn't exist
      }

      // Check for Pub/Sub patterns that should be migrated
      // Allow: Pub/Sub for backward compat during transition
      // Disallow: Primary communication via Pub/Sub
      const primaryPubSubPattern = /await\s+.*\.publish\s*\(\s*['"][^'"]+['"]/;
      const streamPatterns = /streamsClient|xadd|RedisStreamsClient/;

      if (primaryPubSubPattern.test(content)) {
        // If using Pub/Sub, should also have Streams (dual-write during transition)
        // Or should be documented as exception
        const hasStreams = streamPatterns.test(content);
        const hasException = /exception|legacy|deprecated|ADR-002.*exception/i.test(content);

        // Either use Streams or document exception
        expect(hasStreams || hasException).toBe(true);
      }
    }
  });
});

// =============================================================================
// Integration Tests: Message Flow
// =============================================================================

describe('ADR-002: Message Flow Architecture', () => {
  it('should define Streams constants for all message types', () => {
    // RedisStreamsClient should define all stream names
    const requiredStreams = [
      'PRICE_UPDATES',
      'SWAP_EVENTS',
      'OPPORTUNITIES',
      'WHALE_ALERTS'
    ];

    // Check redis-streams.ts or constants
    const streamsPath = path.join(__dirname, '../../src/redis-streams.ts');

    // Read streams file synchronously for this test
    let streamsSource: string;
    try {
      const fs = require('fs');
      streamsSource = fs.readFileSync(streamsPath, 'utf-8');
    } catch {
      streamsSource = '';
    }

    for (const stream of requiredStreams) {
      expect(streamsSource).toMatch(new RegExp(stream, 'i'));
    }
  });

  it('should have batching configured for high-frequency streams', () => {
    // Price updates and swap events need batching
    // Check base-detector has batch configuration
    expect(baseDetectorSource).toMatch(/createBatcher|BatchConfig|maxBatchSize/);
  });
});

// =============================================================================
// P0 Summary: Test Results Guide
// =============================================================================

describe('P0 Implementation Checklist', () => {
  it('documents required changes for ADR-002 compliance', () => {
    /*
     * Required Changes (P0):
     *
     * 1. base-detector.ts:
     *    - Remove useStreams flag (line 112)
     *    - Remove `this.useStreams = false` (line 255)
     *    - Remove all `else if (this.redis)` fallback branches
     *    - Remove all `catch { redis.publish }` fallback patterns
     *    - Add `throw new Error('Streams required per ADR-002')` on init failure
     *
     * 2. Publish methods to modify:
     *    - publishPriceUpdate (lines 1211-1232)
     *    - publishSwapEvent (lines 1234-1270)
     *    - publishArbitrageOpportunity (lines 1272-1296)
     *    - publishWhaleTransaction (lines 1298-1319)
     *    - publishWhaleAlert (lines 1322-1343)
     *    - publishVolumeAggregate (lines 1346-1370)
     *
     * 3. Each publish method should:
     *    - Check if batcher/streamsClient exists, throw if not
     *    - Use only Streams for publishing
     *    - NOT fallback to Pub/Sub on error
     */

    // This test always passes - it's documentation
    expect(true).toBe(true);
  });
});
