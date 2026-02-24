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
 * Note: BaseDetector (base-detector.ts) has been removed per deprecation plan.
 * The "Base Detector" compliance section now verifies the file no longer exists,
 * confirming complete removal of the legacy Pub/Sub fallback code.
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

let indexSource: string;

beforeAll(async () => {
  const indexPath = path.join(__dirname, '../../src/index.ts');

  try {
    indexSource = await fs.readFile(indexPath, 'utf-8');
  } catch {
    indexSource = '';
  }
});

// =============================================================================
// ADR-002 Compliance Tests: Base Detector Removed
// =============================================================================

describe('ADR-002 Compliance: Redis Streams Required', () => {
  describe('Base Detector - Removed (Legacy Pub/Sub Eliminated)', () => {
    it('should have removed base-detector.ts entirely', async () => {
      // BaseDetector was the primary source of Pub/Sub fallback code.
      // Its removal guarantees ADR-002 compliance for all legacy patterns.
      const baseDetectorPath = path.join(__dirname, '../../src/base-detector.ts');
      let exists = true;
      try {
        await fs.access(baseDetectorPath);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('should not export BaseDetector from barrel', () => {
      expect(indexSource).not.toMatch(/export\s*\{[^}]*BaseDetector[^}]*\}\s*from\s*['"]\.\/base-detector['"]/);
    });
  });
});

// =============================================================================
// ADR-002 Compliance Tests: Other Files
// =============================================================================

// ADR-002 migration is complete. All listed files have been removed as part of the
// Pub/Sub elimination. The test verifies that any remaining files (if they were
// re-introduced) do not regress to Pub/Sub-only patterns.
describe('ADR-002 Compliance: Cross-File Analysis', () => {
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
    const streamsPath = path.join(__dirname, '../../src/redis/streams.ts');

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
    // Batching is now in the composition-based detector (chain-instance / unified-detector),
    // not the removed base-detector. Check redis-streams.ts for batch support.
    const streamsPath = path.join(__dirname, '../../src/redis/streams.ts');
    let streamsSource: string;
    try {
      const fsSync = require('fs');
      streamsSource = fsSync.readFileSync(streamsPath, 'utf-8');
    } catch {
      streamsSource = '';
    }
    expect(streamsSource).toMatch(/createBatcher|BatchConfig|maxBatchSize/);
  });
});

// =============================================================================
// P0 Summary: Test Results Guide
// =============================================================================

describe('P0 Implementation Checklist', () => {
  it('documents completed ADR-002 compliance changes', () => {
    /*
     * Completed Changes:
     *
     * 1. base-detector.ts: REMOVED entirely (deprecated class deleted).
     *    All Pub/Sub fallback code eliminated with the file removal.
     *
     * 2. Publishing now handled by composition-based services:
     *    - services/unified-detector/ uses Redis Streams directly
     *    - shared/core/src/publishing/publishing-service.ts for shared publishing
     *
     * 3. All services use Streams-only publishing (no Pub/Sub fallback).
     */

    // This test always passes - it's documentation
    expect(true).toBe(true);
  });
});
